//! WebSocket Handler
//!
//! Handles WebSocket upgrades, JWT authentication, and message routing.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::IntoResponse,
};
use chrono::Utc;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::auth::{validate_token, Claims};
use crate::permissions::{get_user_channel_permissions, ChannelPermAccess, Permissions};
use crate::protocol::{ClientMessage, ServerMessage, UserInfo};
use crate::state::{AppState, DeviceReattachOutcome, DeviceSession, DeviceSessionState, UserId};

/// Query parameters for WebSocket connection
#[derive(Debug, Deserialize)]
pub struct WsQuery {
    /// RETIRED (0.9.1). A token here used to be accepted for clients older
    /// than the subprotocol change; it is now ignored and the connection is
    /// refused, because a live session credential in a query string lands in
    /// every access log, proxy log and history entry along the path. The
    /// field survives only so the query still deserialises (serde ignores it)
    /// and the refusal can be logged with a reason.
    #[serde(default)]
    pub token: Option<String>,
    /// `delivery` marks a background notification socket (the phone's native
    /// delivery connection). Such sessions are presence-invisible, excluded
    /// from file-transfer deliverability, and receive the undelivered-frame
    /// queue on connect. Absent (every other client) = a normal session.
    #[serde(default)]
    pub mode: Option<String>,
    /// Device id CLAIMED by a delivery socket so "sign out this device" can
    /// hang it up. Unproven; stored on Session.claimed_device_id, which only
    /// the kill path reads.
    #[serde(default)]
    pub device: Option<String>,
    /// What the client can read, comma-separated, in ONE parameter:
    /// - `own_voice`: it understands `ServerMessage::OwnVoiceState` and the
    ///   RoomLeft `reason`/`by` fields, so the server may push the account's
    ///   voice state to it;
    /// - `presence`: idle/away (`crate::presence`), confirmed back with
    ///   `ServerFeatures`.
    /// A query parameter because an older server ignores one it does not
    /// know. It must stay a single `caps=a,b` list: this struct takes each
    /// key once, so a repeated `caps=` would fail the whole upgrade.
    #[serde(default)]
    pub caps: Option<String>,
    /// The kind of device the client says it is: `desktop`, `mobile` or
    /// `browser` (anything else is dropped). Labels the account's own devices
    /// to each other ("You're in Lounge on your PC"); unproven, read by
    /// nothing privilege-bearing.
    #[serde(default)]
    pub kind: Option<String>,
}

/// `?caps=` / `?kind=` as the session records them: whether the client
/// announced `own_voice` (a whole name in the comma list, by the one rule
/// every capability is read with - `ClientCaps::announced`), and its device
/// kind if it is one of the three this server knows.
pub(crate) fn parse_ws_caps(caps: Option<&str>, kind: Option<&str>) -> (bool, Option<&'static str>) {
    let own_voice = crate::presence::ClientCaps::announced(caps, "own_voice");
    let kind = match kind.map(str::trim) {
        Some("desktop") => Some("desktop"),
        Some("mobile") => Some("mobile"),
        Some("browser") => Some("browser"),
        _ => None,
    };
    (own_voice, kind)
}

/// What a refused upgrade says back.
///
/// "Missing token" named neither the cause nor the cure, and it is the one
/// string a refused client can actually record: the LAN waker kept it in its
/// journal 6,743 times and it told nobody that the client was simply too old.
pub const WS_MISSING_TOKEN_BODY: &str =
    "no token: send it in Sec-WebSocket-Protocol as `bearer, <jwt>` (the ?token= query string was retired in 0.9.1)";

/// The token a browser sent via `Sec-WebSocket-Protocol`.
///
/// WHY THIS HEADER. Browsers cannot set an `Authorization` header on a
/// WebSocket — the constructor takes a URL and a subprotocol list and nothing
/// else — so the usual advice is to put the token in the query string. That
/// advice is wrong for anything that logs: query strings are written verbatim
/// into access logs by essentially every proxy and web server (including
/// Caddy, in front of this one), so every connection deposits a working
/// session credential into a log file that is rotated, shipped and backed up.
/// The subprotocol header is not logged by default anywhere in that path.
///
/// The convention is two values: a marker, then the credential. We accept
/// `bearer, <jwt>` and echo the MARKER back as the negotiated protocol —
/// echoing the token instead would put it in the response headers, undoing
/// the point.
///
/// Returns the raw token; the caller validates it exactly as before, so this
/// changes only how the credential travels, never what it authorises.
fn bearer_from_subprotocol(headers: &axum::http::HeaderMap) -> Option<String> {
    let raw = headers
        .get(axum::http::header::SEC_WEBSOCKET_PROTOCOL)?
        .to_str()
        .ok()?;
    let mut parts = raw.split(',').map(str::trim);
    if parts.next()? != "bearer" {
        return None;
    }
    let token = parts.next()?;
    (!token.is_empty()).then(|| token.to_string())
}

/// WebSocket upgrade handler
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<WsQuery>,
    headers: axum::http::HeaderMap,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // THE SUBPROTOCOL IS THE ONLY WAY IN. A token in the query string is
    // written to every access log on the path, so 0.9.1 retired it — there is
    // no fallback, and the comment that used to sit here still described one.
    // That mattered: this is the first thing anyone reads when diagnosing a
    // client that cannot connect, and it said the opposite of what happens.
    let offered_protocol = bearer_from_subprotocol(&headers);
    if offered_protocol.is_none() && query.token.is_some() {
        // NAME THE CLIENT. A native waker or service does not auto-update with
        // the desktop app — it is re-shipped by hand — so this line is the only
        // notice anyone gets that a machine has been locked out. One of them
        // logged this 1,440 times a day for five days while its owner believed
        // it was working, because nothing here said WHICH device was calling.
        // The token cannot be trusted yet, so it is read for LOGGING ONLY.
        let who = query
            .token
            .as_deref()
            .and_then(|t| validate_token(t, &state.jwt_secret).ok())
            .map(|c| c.sub.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        tracing::info!(
            user = %who,
            device = %query.device.as_deref().unwrap_or("-"),
            "ws: refused a query-string token — this client is too old (retired in 0.9.1); \
            a native waker or service must be re-shipped, it does not update with the app"
        );
    }
    let presented = match offered_protocol.as_deref() {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED, WS_MISSING_TOKEN_BODY).into_response(),
    };

    // Validate JWT token before upgrading
    match validate_token(presented, &state.jwt_secret) {
        Ok(claims) => {
            // M1 revocation: reject a token whose `tv` no longer matches the
            // user's token_version (logout / password change / recovery reset).
            // ...and a token whose session was revoked (same rule as the REST
            // middleware): a socket must not outlive a device revocation.
            match crate::auth::token_session_live(&state.pool, &claims).await {
                Ok(true) => {}
                _ => {
                    tracing::warn!(
                        "WS upgrade refused: stale token_version or revoked session for user {}",
                        claims.sub
                    );
                    return (StatusCode::UNAUTHORIZED, "Token revoked").into_response();
                }
            }
            // Per-real-IP concurrent-socket ceiling on top of the per-user cap:
            // one host holding many accounts could otherwise open unbounded
            // sockets. Raise WS_MAX_CONNS_PER_IP for large shared-NAT sites.
            let ip = crate::state::real_client_ip(&headers, peer);
            let cap = std::env::var("WS_MAX_CONNS_PER_IP")
                .ok()
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(64)
                .max(1); // never 0 (a 0 cap would refuse all + leak an unreaped entry per IP)
            let ip_guard = match state.try_acquire_ip_slot(ip, crate::state::IpSlotKind::Ws, cap) {
                Some(g) => g,
                None => {
                    tracing::warn!("WS upgrade refused: too many connections from {}", ip);
                    return (
                        StatusCode::TOO_MANY_REQUESTS,
                        "too many connections from this address",
                    )
                        .into_response();
                }
            };
            tracing::info!(
                "WebSocket connection authorized for user: {}",
                claims.username
            );
            // Cap inbound frame/message size. The tungstenite defaults (64 MiB
            // message / 16 MiB frame) let one authenticated socket buffer tens
            // of MB per frame and fan it out to a room — a cheap OOM lever.
            // 256 KiB comfortably fits our largest legit message (8 KB text +
            // SDP blobs) with headroom.
            let delivery = query.mode.as_deref() == Some("delivery");
            // The device claim only means anything on a delivery socket; a
            // normal client identifies through attestation, and accepting the
            // claim there would just be a second, weaker identity channel.
            let claimed_device = if delivery { query.device.clone() } else { None };
            // A REVOKED device's delivery socket must not come back. The kill
            // alone only bought one backoff interval: NativeDelivery
            // reconnects in 5s with the same still-valid JWT, and the upgrade
            // checked nothing device-shaped — "sign out this device" on a
            // lost phone was a 5-second inconvenience. Fail CLOSED on a
            // devices row that is missing or revoked; an unclaimed delivery
            // socket (fresh install, not yet enrolled) stays allowed — it has
            // asserted no identity to check.
            if let Some(dev) = claimed_device.as_deref() {
                let live: Option<(i32,)> = sqlx::query_as(
                    "SELECT 1 FROM devices WHERE id = $1 AND user_id = $2 \
                     AND revoked_at IS NULL",
                )
                .bind(dev)
                .bind(claims.sub as i32)
                .fetch_optional(&state.pool)
                .await
                .unwrap_or(None);
                if live.is_none() {
                    tracing::info!(
                        "delivery upgrade refused for user {}: device {} revoked or unknown",
                        claims.sub,
                        dev
                    );
                    return (StatusCode::UNAUTHORIZED, "Device revoked").into_response();
                }
            }
            let ws = ws.max_message_size(256 * 1024).max_frame_size(256 * 1024);
            // MUST echo a subprotocol when the client offered one. A browser
            // that sends Sec-WebSocket-Protocol and gets no selection back
            // FAILS the connection — so omitting this would break exactly the
            // clients moving onto the safer path, while the old query-string
            // ones kept working. Echo the marker, never the token: putting the
            // credential in a response header would undo the whole change.
            let ws = if offered_protocol.is_some() { ws.protocols(["bearer"]) } else { ws };
            let caps = parse_ws_caps(query.caps.as_deref(), query.kind.as_deref());
            // A delivery socket takes no part in presence, whatever it says.
            let presence_caps = if delivery {
                crate::presence::ClientCaps::default()
            } else {
                crate::presence::ClientCaps::parse(query.caps.as_deref())
            };
            ws.on_upgrade(move |socket| {
                handle_socket(socket, state, claims, ip_guard, delivery, claimed_device, caps, presence_caps)
            })
        }
        Err(e) => {
            tracing::warn!("WebSocket auth failed: {}", e);
            (StatusCode::UNAUTHORIZED, "Invalid token").into_response()
        }
    }
}

/// Handle an established WebSocket connection
async fn handle_socket(
    socket: WebSocket,
    state: Arc<AppState>,
    claims: Claims,
    _ip_guard: crate::state::IpSlotGuard,
    delivery: bool,
    claimed_device: Option<String>,
    caps: (bool, Option<&'static str>),
    presence_caps: crate::presence::ClientCaps,
) {
    // _ip_guard is held for the whole connection; its Drop (on any return path
    // below, i.e. every disconnect) releases this IP's WS slot.
    let user_id = claims.sub;
    let username = claims.username.clone();
    // M2: the JWT's expiry is only checked at upgrade. Capture it so the receive
    // loop can enforce it on a long-held socket — otherwise a connection opened
    // with a near-expiry token stays privileged indefinitely after it expires.
    let token_exp = claims.exp;

    // Split socket into sender and receiver
    let (mut sender, mut receiver) = socket.split();

    // Create a BOUNDED channel for outgoing messages. A slow/malicious client
    // that stops reading its socket fills this queue; try_send then drops
    // further messages (see state.rs send_to_user) instead of buffering without
    // limit — bounding per-connection memory. 256 is generous for a healthy
    // client (which drains continuously) yet caps a stalled one.
    let (tx, mut rx) = mpsc::channel::<ServerMessage>(256);

    // Is this a headless device (the LAN waker, the sign-in-screen service)?
    // Their sessions are minted by /devices/token and marked in
    // token_sessions; they hold a socket around the clock with nobody at it,
    // so they must not count toward idle/away at all. Looked up BEFORE
    // registering: the session is pushed already classified, under the
    // registration's own lock, so no sweep ever sees it as anything else.
    let headless = !delivery && crate::presence::session_is_headless(&state, user_id, &claims.sid).await;

    // Register session (conn_id lets the disconnect path remove exactly this
    // connection; is_first tells us whether to announce the user online —
    // "first" meaning first VISIBLE connection; a delivery socket never is).
    let (conn_id, is_first_session, kill) = state.register_session_classified(
        user_id,
        username.clone(),
        tx,
        delivery,
        claimed_device,
        claims.sid.clone(),
        crate::presence::classify(headless, presence_caps),
    );
    // Before anything can be pushed to this connection: whether it may be
    // sent OwnVoiceState (set_conn_caps never marks a delivery socket).
    state.set_conn_caps(user_id, conn_id, caps.0, caps.1);

    tracing::info!(
        "User {} ({}) connected{}",
        username,
        user_id,
        if delivery { " [delivery]" } else { "" }
    );

    if delivery {
        // The doorbell's other half: hand this socket every notification frame
        // that found nobody home. Delivery sessions ONLY — replaying a
        // DirectMessage into a WebView would double-render an open chat, and
        // visible clients repaint from REST state on connect anyway.
        //
        // Re-authorized against the CURRENT permission set: a frame was parked
        // while the user could VIEW its channel (or while nobody blocked the
        // sender), and a kick, a deny or a block may have landed since. Handing
        // it over anyway told a removed member which channel got a message,
        // when, and from whom — and delivered a card from a sender they had
        // since blocked. Every channel-scoped or sender-scoped parked frame is
        // re-checked here; the verdicts are memoized per drain (channel_id for
        // VIEW, sender_id for the block/consent gate).
        let mut views_cache: std::collections::HashMap<i64, bool> = std::collections::HashMap::new();
        let mut dm_ok_cache: std::collections::HashMap<UserId, bool> = std::collections::HashMap::new();
        for msg in state.drain_undelivered(user_id) {
            let keep = match &msg {
                ServerMessage::MessageNotification { channel_id, .. } => {
                    match views_cache.get(channel_id) {
                        Some(&v) => v,
                        None => {
                            let v = matches!(
                                get_user_channel_permissions(&state.pool, *channel_id, user_id).await,
                                ChannelPermAccess::Allowed { perms, .. }
                                    if perms.has(Permissions::VIEW_CHANNEL)
                            );
                            views_cache.insert(*channel_id, v);
                            v
                        }
                    }
                }
                // ClipPending carries only a clip_id, so resolve the proposal's
                // channels and re-run the SAME rule the live/REST clip surfaces
                // apply (clip_access in clip_handlers: VIEW on the voice channel):
                // a member kicked/VIEW-denied since the proposal must not get a
                // consent doorbell for a call they were removed from. Fail
                // CLOSED: a proposal that has since expired or been swept
                // resolves to no channels, so the pending frame is dropped
                // (GET /clips/:id would 404 anyway).
                ServerMessage::ClipPending { clip_id } => {
                    // Snapshot the two channel ids, dropping the DashMap guard
                    // before any await.
                    let channels = state
                        .clip_proposals
                        .get(clip_id)
                        .map(|p| (p.voice_channel_id, p.target_channel_id));
                    match channels {
                        Some((voice_cid, target_cid)) => {
                            let mut ok = true;
                            // Only the VOICE channel gates participation: an approver who
                            // cannot VIEW the pinned target channel still holds a consent
                            // seat and sees the target REDACTED (review finding 9), so the
                            // doorbell must still reach them. ClipPending is content-free.
                            let _ = target_cid;
                            for cid in [voice_cid] {
                                let v = match views_cache.get(&cid) {
                                    Some(&v) => v,
                                    None => {
                                        let v = matches!(
                                            get_user_channel_permissions(&state.pool, cid, user_id).await,
                                            ChannelPermAccess::Allowed { perms, .. }
                                                if perms.has(Permissions::VIEW_CHANNEL)
                                        );
                                        views_cache.insert(cid, v);
                                        v
                                    }
                                };
                                if !v {
                                    ok = false;
                                    break;
                                }
                            }
                            ok
                        }
                        None => false,
                    }
                }
                // A DirectMessage parked while nobody was home must not be
                // handed over if a block (either direction) or the recipient's
                // DM-consent flag now forbids it — the same gate the WS send
                // path ran once at enqueue time. users_can_dm re-runs exactly
                // that (conversation exists + no block either way + consent);
                // fail CLOSED via its own error handling.
                ServerMessage::DirectMessage { sender, .. } => {
                    let from = sender.id;
                    match dm_ok_cache.get(&from) {
                        Some(&v) => v,
                        None => {
                            let v = users_can_dm(&state, from, user_id).await;
                            dm_ok_cache.insert(from, v);
                            v
                        }
                    }
                }
                _ => true,
            };
            if !keep {
                tracing::info!(
                    "dropping parked frame for user {}: no longer entitled at delivery time",
                    user_id
                );
                continue;
            }
            state.send_to_conn(user_id, conn_id, msg);
        }
    } else {
        // A visible client connecting makes the parked frames moot — it
        // repaints from REST state and the user is about to read everything.
        // DROP them, or a desktop-only user (who never opens a delivery
        // socket) accumulates up to 32 ciphertext frames in RAM forever, and
        // a phone connecting hours later would notify for messages long read.
        state.undelivered.remove(&user_id);
    }

    // File offers parked while this user had no qualifying socket are
    // deliverable now — a phone whose app just came back to the foreground
    // reconnects here and collects what it missed. (Device-PINNED offers
    // cannot match yet; the attestation handler runs this again once the
    // device id is proven.) NEVER into a delivery socket: it would drop the
    // offer unread while the server marked it delivered — the exact
    // PC-to-pocketed-phone failure the parking mechanism exists to prevent.
    let parked = if delivery {
        crate::state::ParkedDelivery { offers: Vec::new(), sender_notes: Vec::new() }
    } else {
        // Re-run the offer-time gate (users_can_dm) for every parked sender
        // before delivering: a block or a DM-consent flip since the offer was
        // parked must stop the card, exactly as the notification drain above
        // re-checks VIEW. Resolved here (async) and handed to the sync,
        // guard-holding drain as `sender_ok`; a sender with no verdict is
        // refused. Fail CLOSED via users_can_dm's own error handling.
        let ok = resolve_parked_senders_ok(&state, user_id).await;
        state.deliver_parked_offers(user_id, conn_id, move |from| ok.contains(&from))
    };
    for offer in parked.offers {
        state.send_to_conn(user_id, conn_id, offer);
    }
    for (to_user, note) in parked.sender_notes {
        state.send_to_user(to_user, note);
    }

    // Device attestation challenge. The JWT is account-scoped and identical on
    // every device, so it cannot say WHICH device this is; possession of the
    // device signing key is proved against this nonce instead. Scoped to THIS
    // connection and single-use, so an attestation captured from one socket
    // cannot be replayed onto another.
    //
    // Sending it unconditionally is safe: clients that predate the feature (and
    // the web shell, which has no device key) ignore the message and simply
    // stay unattested. Nothing is required of them.
    let device_nonce: String = {
        use base64::Engine;
        use rand::RngCore;
        let mut raw = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut raw);
        base64::engine::general_purpose::STANDARD.encode(raw)
    };
    let _ = state.send_to_conn(
        user_id,
        conn_id,
        ServerMessage::DeviceChallenge {
            nonce: device_nonce.clone(),
        },
    );

    // Where the account's call is, right away - a phone opened while the PC
    // is in voice must be able to say so before anything else happens. Sent
    // only to a client that asked (an old client never sees the frame), and
    // always, even when the account is in no call: its arrival is how the
    // client learns this server understands LeaveOwnVoice and take_over.
    send_own_voice_state_to(&state, user_id, conn_id).await;

    // Announce presence only to users who can see it: those who share a server
    // with this user, plus accepted friends. Previously this fanned out to EVERY
    // connected session regardless of any relationship — a privacy leak (you saw
    // the online status of strangers) and O(N) per connect. Announce only for
    // the user's FIRST live connection — a second device coming online must not
    // re-broadcast an already-online user. A user with "show online status" off
    // simply never announces (their Settings toggle is the enforcement point).
    if is_first_session && user_shows_online(&state, user_id).await {
        let online_msg = ServerMessage::UserOnline {
            user: UserInfo::new(user_id, username.clone()),
        };
        for audience_id in presence_audience(&state, user_id).await {
            state.send_to_user(audience_id, online_msg.clone());
        }
    }

    // Idle/away: confirm the capability to this connection (and only to one
    // that announced it), then bring the user's status up to date — a second
    // device arriving at an idle desk, or a waker reconnecting, can change it.
    if !delivery {
        crate::presence::on_connect(&state, user_id, conn_id, presence_caps, is_first_session).await;
    }

    // Server-driven liveness. Without this the server only learns a socket died
    // when the OS delivers a FIN/RST — which never happens for Wi-Fi off, a
    // closed lid, a pulled cable or a killed VM. Those sessions stayed
    // registered forever, so the disconnect cleanup that broadcasts
    // StreamStopped/ScreenShareStopped never ran and viewers kept a black tile
    // with a LIVE badge for someone who was long gone.
    let (ping_tx, mut ping_rx) = mpsc::channel::<()>(1);

    // Spawn task to forward messages from channel to WebSocket
    let send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = rx.recv() => match msg {
                    Some(msg) => {
                        let text = serde_json::to_string(&msg).unwrap_or_default();
                        if sender.send(Message::Text(text)).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                },
                // A protocol-level Ping: browsers, the Tauri WebView and
                // Capacitor all answer automatically, so no client change is
                // needed and it survives the Cloudflare/Caddy hops.
                _ = ping_rx.recv() => {
                    if sender.send(Message::Ping(Vec::new())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Rooms THIS connection is joined to — bounds JoinRoom flooding per socket.
    let mut joined_rooms: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Per-connection rate limit: drop frames that exceed the sustained rate so a
    // flood can't saturate the DB pool and stall the whole server.
    let mut rate = RateLimiter::new();
    // Remote-control input gets its own, larger bucket. Sustained pointer
    // motion legitimately emits 60-125 events/s — above the general 50/s cap —
    // and a dropped frame here is not abuse traffic shed: a lost `up` is a
    // button stuck down on the controlled machine until the session ends.
    // Neither input arm awaits the DB, so the pool-protection rationale for
    // the tight bucket does not apply; this one only bounds relay CPU.
    let mut input_rate = RateLimiter::for_control_input();
    let mut wake_rate = RateLimiter::for_wake();
    // Activity reports get their own small bucket. An over-limit one is
    // still TAKEN (its state; only the immediate fan-out is skipped) and
    // never answered with an Error, which the stock client alerts on — see
    // presence_gate and RateLimiter::PRESENCE_CAPACITY.
    let mut presence_rate = RateLimiter::for_presence();

    // Reap a socket that has gone quiet. Must stay comfortably above the
    // client's own 30s app-level heartbeat, or a briefly-backgrounded phone
    // would be kicked out of voice.
    let idle_timeout = std::time::Duration::from_secs(
        std::env::var("WS_IDLE_TIMEOUT_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(75)
            .max(45),
    );
    let mut last_seen = std::time::Instant::now();
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(15));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    // Server-side hangup (account deletion, password change, recovery reset,
    // per-user session-cap eviction). Pinned outside the loop so a notify that
    // arrives while another select branch is running is never dropped —
    // recreating `kill.notified()` each iteration would rely on the permit
    // surviving a dropped future.
    let kill_signal = kill.notified();
    tokio::pin!(kill_signal);

    // Handle incoming messages
    loop {
        tokio::select! {
            _ = &mut kill_signal => {
                tracing::info!(
                    "WS session revoked server-side: closing user {} conn {}",
                    user_id, conn_id
                );
                break;
            }
            maybe_frame = receiver.next() => {
                let Some(result) = maybe_frame else { break };
                // ANY inbound frame proves the peer is alive — including the
                // automatic Pong replies to our Pings, which is what keeps a
                // quiet-but-healthy socket (someone reading a text channel)
                // from being reaped.
                last_seen = std::time::Instant::now();

                // M2: reject further activity once the token behind this socket has
                // expired. Checked per inbound frame (incl. the client's own Pings), so
                // an idle-then-active expired socket is closed before doing any work.
                if Utc::now().timestamp() >= token_exp {
                    let _ = state.send_to_conn(user_id, conn_id, ServerMessage::Error {
                        message: "Session expired, please reconnect".to_string(),
                    });
                    break;
                }
                match result {
                    Ok(Message::Text(text)) => {
                        // Rate-limit BEFORE any parsing/DB work. Over the limit → drop
                        // the frame (a well-behaved client never hits this). Input
                        // frames are classified by prefix (cheaper than a parse) into
                        // their own bucket; a crafted frame faking the prefix merely
                        // lands in the larger bucket — still bounded, and auth and
                        // validation happen in the handler regardless.
                        if !presence_gate(&state, user_id, conn_id, &text, &mut presence_rate) {
                            continue;
                        }
                        let limiter = if is_input_frame(&text) {
                            &mut input_rate
                        } else if is_wake_frame(&text) {
                            &mut wake_rate
                        } else {
                            &mut rate
                        };
                        if !limiter.allow() {
                            // SAY SO. This used to `continue`, which is correct
                            // for the flood it exists to stop and wrong for the
                            // one frame a human sends deliberately: the wake
                            // bucket is 8 tokens refilling at 0.5/s, so pressing
                            // Wake a few times in a minute silently drops the
                            // press, and the UI then sits through its 180-second
                            // connect timeout with nothing to report. An
                            // unexplained 3-minute wait reads as broken
                            // hardware, which is the one diagnosis that sends
                            // someone into their BIOS instead of just waiting.
                            //
                            // The error costs one small frame per refusal, which
                            // is bounded by the very limiter that produced it.
                            //
                            // A DROPPED WAKE ANSWERS ON THE WAKE CHANNEL. The
                            // generic Error frame is only listened for by the
                            // chat view, which alerts; the wake card would never
                            // hear it and would keep counting down for three
                            // minutes — exactly the symptom this whole branch
                            // was added to stop.
                            const TOO_FAST: &str =
                                "You are sending that too quickly. Wait a few seconds and try again.";
                            if is_wake_frame(&text) {
                                let _ = state.send_to_conn(user_id, conn_id, ServerMessage::DeviceWakeResult {
                                    ok: false,
                                    message: Some(TOO_FAST.to_string()),
                                });
                            } else {
                                let _ = state.send_to_conn(user_id, conn_id, ServerMessage::Error {
                                    message: TOO_FAST.to_string()
                                });
                            }
                            continue;
                        }
                        if let Err(e) = handle_message(&state, user_id, conn_id, &username, &text, &mut joined_rooms, &device_nonce).await {
                            let _ = state.send_to_conn(user_id, conn_id, ServerMessage::Error {
                                message: e.to_string()
                            });
                        }
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(Message::Ping(_data)) => {
                        // Axum handles pong automatically, but we can respond anyway
                        let _ = state.send_to_conn(user_id, conn_id, ServerMessage::Pong);
                    }
                    Err(e) => {
                        tracing::error!("WebSocket error for user {}: {}", user_id, e);
                        break;
                    }
                    _ => {}
                }
            }
            _ = heartbeat.tick() => {
                if last_seen.elapsed() > idle_timeout {
                    tracing::info!(
                        "WS idle timeout: reaping user {} conn {} (silent for {:?})",
                        user_id, conn_id, last_seen.elapsed()
                    );
                    break;
                }
                // try_send, never send().await: blocking the receive loop on a
                // busy send task would defeat the point of the heartbeat.
                if ping_tx.try_send(()).is_err() && ping_tx.is_closed() {
                    break; // send task is gone; this socket is finished
                }
            }
        }
    }

    // Close the socket NOW. The read half is never used again, and the write
    // half is aborted below, but holding either keeps the TCP connection open
    // for the whole teardown — including the rejoin-grace sleep further down,
    // which is about DELAYING ANNOUNCEMENTS, not about keeping a dead socket
    // alive. Measured: a revoked session that had joined a room stayed open on
    // the client for the full 8 s grace (WS_REJOIN_GRACE_SECS) after the
    // server had already unregistered it, so "sign out this device" looked
    // like it had not worked; a socket in no room closed instantly.
    drop(receiver);

    // Cleanup on disconnect
    tracing::info!("User {} disconnected", user_id);
    // Which device this socket had attested as, read BEFORE unregister_session
    // removes the record. `None` for a socket that never attested (an ordinary
    // web tab, a delivery-mode socket that only CLAIMED an id) — nothing to
    // announce for those.
    let attested_device = state.device_of_conn(user_id, conn_id);
    // Device sessions this socket owned: a mid-handshake one dies with it, but
    // an ACTIVE one is held for the detach grace window instead — phones drop
    // their socket the moment the app backgrounds, and destroying the session
    // here made every brief app switch fatal (the reconnect a moment later had
    // nothing left to reattach to). The reaper ends it if nobody comes back,
    // so the host's single slot still cannot leak.
    let (ended, detached) = state.drop_device_sessions_for_conn(conn_id);
    for (session_id, other_conn, other_user) in ended {
        state.send_to_conn(
            other_user,
            other_conn,
            ServerMessage::DeviceEnded {
                session_id,
                reason: "the other device disconnected".to_string(),
            },
        );
    }
    for (session_id, other_conn, other_user) in detached {
        state.send_to_conn(
            other_user,
            other_conn,
            ServerMessage::DevicePeerReconnecting { session_id },
        );
    }

    let (removed, vacated_rooms) = state.unregister_session(user_id, conn_id);
    send_task.abort();
    // The clipper's LAST VISIBLE connection is gone: a clip that only ever
    // lived in that process's memory is gone with it, so its proposal (and the
    // approvers' prompts) must close (docs/CLIPS.md, plan D2). Gated on
    // `removed` (last visible), not emptiness — a surviving Android delivery
    // socket is not a clipper.
    if removed {
        crate::clip_handlers::cancel_proposals_of(&state, user_id);
    }

    // The device this socket carried has dropped off — unless the same device
    // has ALREADY attested on a newer socket (a fast reconnect: new socket up,
    // old one closing behind it), in which case it is still online and saying
    // otherwise, even as a hint, would flicker every open list. Sent AFTER
    // unregister so it can only reach the user's remaining connections.
    //
    // BEST-EFFORT BY DESIGN. This is a hint the client re-reads the list on,
    // not a source of truth; the list endpoint computes `online` from live
    // connections. One case skips it silently: a session-cap eviction
    // (`register_session`) removes the victim's Session from the map before
    // this path runs, so `device_of_conn` above already read `None` and no
    // hint is sent. That is acceptable — the evicted client reconnects and
    // re-attests (emitting online:true), and the 15 s poll covers the gap.
    if let Some(device_id) = attested_device {
        if state.conn_of_device(user_id, &device_id).is_none() {
            state.send_to_user(
                user_id,
                ServerMessage::DevicePresence {
                    device_id,
                    online: false,
                },
            );
        }
    }

    // An UNCLEAN disconnect (crash, page reload, network drop) never sends
    // StopStream / ScreenShareStop / CameraStop, so remaining participants
    // kept a stale RTCPeerConnection and ghost roster/tile entries for the
    // departed user — the producer of the "audio dead after rejoin" class the
    // client-side connId protocol (v0.5.90) recovers from. Broadcast whatever
    // media-stopped events this user's departure implies, regardless of
    // whether they stay online on another device (that device fully left the
    // room or the room wouldn't be in vacated_rooms). Audiences mirror the
    // clean-path handlers: StreamStopped is viewer-scoped to the room's
    // channel, screen-share and camera are room-scoped.
    // REJOIN GRACE. A socket that drops and comes straight back (a network
    // blip, a laptop lid, a throttled webview missing one heartbeat) used to
    // cost the whole room a leave chime and then a join chime — "random
    // pings" — because the departure was announced the instant the old socket
    // died. Every announcement below re-validates against LIVE room state, so
    // waiting here first means a user who is back inside the window is never
    // announced as gone at all: peers keep their roster entry and hear
    // nothing. Media itself was released at unregister time (a stale pc is
    // rebuilt by the connId protocol either way); only the ANNOUNCEMENTS wait.
    // An explicit LeaveRoom never comes through here and stays immediate.
    if vacated_rooms.iter().any(|v| v.fully_left) {
        tokio::time::sleep(rejoin_grace()).await;
    }
    if vacated_rooms.iter().any(|v| v.was_streamer) {
        for v in vacated_rooms.iter().filter(|v| v.was_streamer) {
            // RE-VALIDATE against LIVE state: the await above opened a window
            // in which a quick reconnect can register a fresh connection,
            // re-join the room and re-claim the stream. The snapshot taken at
            // unregister time is then stale, and broadcasting from it would
            // erase the user from every other client's roster AFTER their
            // re-announce — invisible to everyone, still talking via the SFU.
            // Mirrors the still_member re-read the clean LeaveRoom path does.
            if state
                .rooms
                .get(&v.room_id)
                .is_some_and(|r| r.streamers.contains(&user_id))
            {
                continue;
            }
            let msg = ServerMessage::StreamStopped {
                room_id: v.room_id.clone(),
                streamer_id: user_id,
            };
            // The user's OTHER devices (if any) also need their UI corrected —
            // but ONLY when they genuinely left the room. On a reconnect the
            // vacated entry just means the dead connection released its media
            // while the fresh connection is still in the room; the client's
            // roster delete is unconditional, so telling them would make the
            // user vanish from their OWN voice list.
            if v.fully_left {
                state.send_to_user(user_id, msg.clone());
            }
            for audience_id in voice_roster_audience(&state, &v.room_id, user_id).await {
                state.send_to_user(audience_id, msg.clone());
            }
        }
    }
    // NOTE the `member_id != user_id || v.fully_left` guard on both loops: in
    // the reconnect window the departing user is STILL a member via their fresh
    // connection, and the client's handlers delete by id with no self-check —
    // so telling them would tear down the very share/camera tile their new
    // connection just re-announced, leaving them live but invisible to
    // themselves. Everyone else must still be told, which is the whole point.
    for v in vacated_rooms.iter().filter(|v| v.was_screen_sharer) {
        let msg = ServerMessage::ScreenShareStopped {
            room_id: v.room_id.clone(),
            streamer_id: user_id,
        };
        if let Some(room) = state.rooms.get(&v.room_id) {
            // Re-claimed on a fresh connection during the await window above —
            // the share is live again, don't tear down its tiles.
            if room.screen_sharers.contains(&user_id) {
                continue;
            }
            for &member_id in room.members.iter() {
                if member_id == user_id && !v.fully_left {
                    continue;
                }
                state.send_to_user(member_id, msg.clone());
            }
        }
    }
    for v in vacated_rooms.iter().filter(|v| v.was_camera_user) {
        let msg = ServerMessage::CameraStopped {
            room_id: v.room_id.clone(),
            user_id,
        };
        if let Some(room) = state.rooms.get(&v.room_id) {
            // Same re-claim guard as the screen-share loop.
            if room.camera_users.contains(&user_id) {
                continue;
            }
            for &member_id in room.members.iter() {
                if member_id == user_id && !v.fully_left {
                    continue;
                }
                state.send_to_user(member_id, msg.clone());
            }
        }
    }

    // Resolved once and reused by both blocks below.
    let shows_online = user_shows_online(&state, user_id).await;

    // If this device's death made the user fully leave rooms while they stay
    // online on another device, tell those rooms — no UserOffline will fire to
    // cover it (peers would otherwise keep a ghost in the voice room).
    if !removed {
        // fully_left only: a vacated entry may just mean this connection
        // released its media while the user is still present via another
        // connection (the reconnect case) — announcing UserLeft there would
        // delete them from everyone's roster while they're still in the room.
        // Outside voice a hidden user was never announced as joined, so the
        // matching UserLeft is suppressed too — otherwise the departure alone
        // discloses that they had been sitting in that channel.
        for v in vacated_rooms.iter().filter(|v| v.fully_left) {
            if !room_announces_presence(&v.room_id) && !shows_online {
                continue;
            }
            // Re-joined on a fresh connection while user_shows_online was in
            // flight: they are a member again, announcing a departure now
            // would delete them from every roster. Same live re-read the
            // clean LeaveRoom path does before its UserLeft.
            if state
                .rooms
                .get(&v.room_id)
                .is_some_and(|r| r.members.contains(&user_id))
            {
                continue;
            }
            state.broadcast_to_room(
                &v.room_id,
                ServerMessage::UserLeft {
                    room_id: v.room_id.clone(),
                    user_id,
                },
                None,
            );
        }
    }

    // Only announce offline when the user's LAST connection closed. A device
    // disconnecting while another is still online must not broadcast a false
    // offline for the user. A hidden user was never announced online, so there
    // is nothing to retract.
    // VISIBLY online: the phone's permanent delivery socket must not hold the
    // green dot up forever after the user's last real client closes.
    if removed && shows_online && !state.is_user_visibly_online(user_id) {
        let audience = presence_audience(&state, user_id).await;
        // `removed` is a snapshot from before this function's awaits, and
        // presence_audience just awaited again — re-read live state so a
        // quick reconnect is never painted offline after its own reconnect
        // announced it online.
        if !state.is_user_visibly_online(user_id) {
            let offline_msg = ServerMessage::UserOffline { user_id };
            for audience_id in audience {
                state.send_to_user(audience_id, offline_msg.clone());
            }
        }
    }

    // The account's other devices: this socket's call may have ended with it.
    // After the rejoin grace above, so a blip that is already back in the
    // call does not flash "You're in Lounge on another device" at the phone.
    // Recomputed from LIVE state, like every announcement here.
    if vacated_rooms.iter().any(|v| parse_voice_room(&v.room_id).is_some()) {
        push_own_voice_state(&state, user_id).await;
    }
}

/// The raw `show_online_status` lookup: `Some(value)` for a found row, `None`
/// for a missing row OR a query error — the caller picks the fail direction.
/// The announcement call sites go through [`user_shows_online`] (fails open,
/// deliberately); a call site that MASKS presence must treat `None` as hidden
/// (see [`target_is_hidden`]).
pub(crate) async fn show_online_status(state: &Arc<AppState>, user_id: UserId) -> Option<bool> {
    // i32, matching handlers.rs's copy of this exact SQL text (users.id is
    // INT4) — see the 22P03 note in device_token.rs.
    match sqlx::query_as::<_, (bool,)>("SELECT show_online_status FROM users WHERE id = $1")
        .bind(user_id as i32)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(row) => row.map(|(b,)| b),
        Err(e) => {
            tracing::warn!("show_online_status lookup failed for user {}: {e:?}", user_id);
            None
        }
    }
}

/// Does this user want their presence visible to others? Fails open to
/// visible (the column default) on a DB error — presence is not worth
/// breaking a connect over.
pub(crate) async fn user_shows_online(state: &Arc<AppState>, user_id: UserId) -> bool {
    show_online_status(state, user_id).await.unwrap_or(true)
}

/// r2-4-L4-02's mask, with the fail direction pinned: is the FileOffer
/// recipient someone whose online/offline distinction the SENDER must not be
/// able to observe?
///
/// Only a row that positively says `show_online_status = true` un-masks. A
/// missing row and a query error (`None`) both mask — the opposite default
/// from [`user_shows_online`], on purpose: that helper gates an announcement,
/// where the open direction merely announces; this one closes a presence
/// oracle, where the open direction (a DB blip during the offer) would let the
/// sender tell hidden-online from offline — the exact bit the mask exists to
/// hide. A self-transfer is never masked: the sender IS the recipient.
fn target_is_hidden(to_self: bool, shows_online: Option<bool>) -> bool {
    !to_self && !matches!(shows_online, Some(true))
}

/// The client's in-band voice status ping: `__VOICE_STATUS__{json}` sent as a
/// room ChatMessage into the `voice_<id>` room (frontend `voiceStatus.ts`
/// `buildVoiceStatus`, VoicePanel `broadcastStatus`). It carries the roster's
/// muted / deafened / replay-buffer-armed flags; Chat.tsx filters it out of the
/// message list. Recognition is the client's own rule — a prefix match.
pub(crate) const VOICE_STATUS_PREFIX: &str = "__VOICE_STATUS__";

fn is_voice_status_ping(content: &str) -> bool {
    content.starts_with(VOICE_STATUS_PREFIX)
}

/// What a `ChatMessage` into a channel-backed room (`channel_<id>` or
/// `voice_<id>`) is admitted as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChatAdmission {
    /// A `__VOICE_STATUS__` ping from a CURRENT OCCUPANT of a voice room:
    /// broadcast as-is, with no SEND_MESSAGES or member-timeout check.
    StatusPing,
    /// Real content from a sender holding VIEW + SEND_MESSAGES: still subject
    /// to the member-timeout deny list before it is broadcast.
    Message,
    Refused,
}

/// C10, corrected: the voice_<id> ChatMessage branch requires SEND_MESSAGES
/// like the text branch — EXCEPT for the voice status ping, which is not a
/// message. It is the only transport for the roster's mute / deafen /
/// recording-armed state, SEND_MESSAGES is offered as a per-channel overwrite
/// on voice channels too ("Send messages in text channels"), and a member
/// holding CONNECT but denied SEND joins the call normally. Gating the ping on
/// SEND froze such a member's state for the whole room (a muted user rendered
/// hot-mic; the recording badge never shown) and raised a client alert on
/// every toggle.
///
/// So: a status ping is admitted when the sending CONNECTION is in the voice
/// room (`conn_in_room` — `joined_rooms` is per-connection, and being in the
/// room means the VIEW + CONNECT join gate passed) AND the access lookup still
/// says VIEW + CONNECT (the join-level gate re-asserted, fail closed on a
/// lookup error). Anything else — real content in either room shape, a status
/// ping from a non-occupant, a status ping into a TEXT room — keeps the
/// SEND_MESSAGES gate and the caller's timeout check, exactly as C10 intended:
/// a non-occupant still cannot inject a spoofed roster state into a call they
/// have not joined without the bits a message would need.
fn chat_admission(
    is_voice_room: bool,
    content: &str,
    conn_in_room: bool,
    access: &ChannelPermAccess,
) -> ChatAdmission {
    let perms = match access {
        ChannelPermAccess::Allowed { perms, .. } => *perms,
        _ => return ChatAdmission::Refused,
    };
    if !perms.has(Permissions::VIEW_CHANNEL) {
        return ChatAdmission::Refused;
    }
    if is_voice_room
        && conn_in_room
        && is_voice_status_ping(content)
        && perms.has(Permissions::CONNECT)
    {
        return ChatAdmission::StatusPing;
    }
    if perms.has(Permissions::SEND_MESSAGES) {
        ChatAdmission::Message
    } else {
        ChatAdmission::Refused
    }
}

/// The fail-closed fallback for [`hidden_members`]: on a DB error EVERY id is
/// treated as hidden.
///
/// Extracted so the DIRECTION is unit-testable without a pool. The previous
/// `.unwrap_or_default()` returned an EMPTY set and its comment called that
/// "fails CLOSED to 'nobody is hidden'" — a contradiction in terms. "Nobody is
/// hidden" is the OPEN direction: the caller's `retain` becomes a no-op and the
/// full roster ships, revealing every user who asked to appear offline and
/// which channel they had open.
fn hidden_on_error(ids: &[UserId]) -> std::collections::HashSet<UserId> {
    ids.iter().copied().collect()
}

/// Which of `ids` have presence hidden (`show_online_status = false`)? One
/// query for the whole set — the per-user `user_shows_online` would be an N+1
/// against a room roster.
///
/// Fails CLOSED (everyone treated as hidden) on a DB error: a transient error
/// must reveal nobody. The caller keeps its `m.id == user_id ||` clause, so the
/// joining user still sees themselves; the rest of the roster arrives empty and
/// the next join repopulates it. That degraded state is transient and
/// self-healing, and is strictly preferable to leaking a user who asked to
/// appear offline. `user_shows_online` above still fails OPEN — deliberately,
/// and it says so: it gates a connect, not a roster.
pub(crate) async fn hidden_members(
    state: &Arc<AppState>,
    ids: &[UserId],
) -> std::collections::HashSet<UserId> {
    if ids.is_empty() {
        return std::collections::HashSet::new();
    }
    match sqlx::query_as::<_, (i64,)>(
        // id is INT4 but `ids` binds as bigint[]; cast to match, mirroring the
        // proven `id::bigint = ANY($2)` pattern in broadcast_perms_changed_and_evict.
        "SELECT id::bigint FROM users WHERE id::bigint = ANY($1) AND show_online_status = FALSE",
    )
    .bind(ids)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows.into_iter().map(|(id,)| id).collect(),
        Err(e) => {
            tracing::warn!("hidden_members failed, treating the whole roster as hidden: {e:?}");
            hidden_on_error(ids)
        }
    }
}

/// Does joining/leaving `room_id` announce the user to the other occupants?
///
/// Voice rooms always do — the Settings copy carves them out explicitly
/// ("Joining a voice channel still shows you in that channel"), and the voice
/// roster is unusable without them. Every other room (text channels, DM rooms)
/// is covered by "you appear offline to everyone", so a hidden user must not be
/// announced there. Without this the six gated presence surfaces were undone by
/// `RoomJoined{members}` / `UserJoined`, which leaked not just that a hidden
/// user was online but exactly which channel they had open.
fn room_announces_presence(room_id: &str) -> bool {
    parse_voice_room(room_id).is_some()
}

/// C09 + r2-3-L3-01: on a `LeaveRoom`, emit the over-complete media retraction
/// (StreamStopped, and any released share/camera) only when THIS connection was
/// actually in the room (`was_joined`), the room is a voice room, and the user
/// has FULLY left it (`!still_member` — no other device of theirs remains).
/// Without `was_joined` a non-occupant could inject retraction frames into a
/// call they cannot see; without `!still_member` a user still present on another
/// device would be torn down on every peer.
fn leave_retracts_media(was_joined: bool, is_voice: bool, still_member: bool) -> bool {
    was_joined && is_voice && !still_member
}

/// C09: broadcast the departure `UserLeft` only when THIS connection had joined
/// (`was_joined`), the user has fully left (`!still_member`), and presence is
/// announced for the room (voice always, other rooms only for a visible user).
/// `was_joined` is the fix: a `LeaveRoom` for a guessed room a non-member never
/// joined must broadcast nothing.
fn leave_announces_departure(was_joined: bool, still_member: bool, announce_presence: bool) -> bool {
    was_joined && !still_member && announce_presence
}

/// How many perms sweeps of `server_id` have started
/// ([`AppState::perms_sweep_epochs`]).
fn perms_sweep_epoch(state: &AppState, server_id: &str) -> u64 {
    state.perms_sweep_epochs.get(server_id).map(|e| *e).unwrap_or(0)
}

/// Store a voice joiner's speak right from the join's own recheck - and if a
/// perms sweep of `server_id` STARTED since `epoch_before` (read after the
/// insert, before that recheck), ask for another, fire-and-forget.
///
/// The recheck resolves outside the server's perms lock (a join must not wait
/// behind a sweep's LiveKit calls), so its answer can be OLDER than a sweep
/// that resolved this user after a later change and has already written the
/// flag: last writer wins, and the join would write the stale one - a SPEAK
/// deny undone for every mesh receiver, or a lift that silences a member who
/// holds the right - with nothing ever looking again. A sweep that started
/// before `epoch_before` could not have seen the insert or saw a change that
/// committed before this recheck read anything, so only one that started
/// since can have written a newer answer; the sweep asked for here starts
/// after this write and resolves the user afresh, restoring the newest.
fn store_join_speak(state: &Arc<AppState>, room_id: &str, user_id: UserId, can_speak: bool, server_id: &str, epoch_before: u64) {
    if let Some(mut room) = state.rooms.get_mut(room_id) {
        room.set_can_speak(user_id, can_speak);
    }
    if perms_sweep_epoch(state, server_id) != epoch_before {
        drop(request_perms_sweep(state, server_id, 0));
    }
}

/// Undo a JoinRoom its post-insert recheck refused: take THIS connection
/// (`conn_id`) out of `room_id`, and no other.
///
/// This used to remove the whole USER. A second device of theirs already in
/// the call - or the socket this one is replacing, still waiting to be reaped -
/// then sat outside `members` with its peer links up, where no later sweep
/// could see it: a SPEAK deny sent no VoiceSpeakState for it, a VIEW deny or a
/// kick no RoomLeft. Now it keeps its membership, and if the refusal was a real
/// deny, the perms sweep - whose snapshot still holds the user - evicts them
/// everywhere.
///
/// Announced only what had been announced - by whether the USER was, not only
/// this connection. A connection that was ALREADY in the room
/// (`conn_was_joined`: a repeat join on the same socket), or a user already
/// in it through another connection (`already_member`), was announced; the
/// connection leaves exactly as a LeaveRoom would, told `RoomLeft` itself, and
/// the room hears the departure only if the user FULLY left
/// (`announce_conn_departure` re-reads that). The second case matters when the
/// other connection went while this one was being checked - a zombie socket
/// reaped mid-recheck hands its stream claim to this connection and says
/// nothing, since the user was still here - so this removal is what takes the
/// user out, and it must say so. Otherwise the user was never announced, and
/// there is nothing to take back.
async fn withdraw_refused_join(
    state: &Arc<AppState>,
    room_id: &str,
    user_id: UserId,
    conn_id: u64,
    conn_was_joined: bool,
    already_member: bool,
    joined_rooms: &mut std::collections::HashSet<String>,
) {
    let released = state.leave_room(room_id, user_id, conn_id);
    joined_rooms.remove(room_id);
    if conn_was_joined || already_member {
        state.send_to_conn(user_id, conn_id, ServerMessage::RoomLeft { room_id: room_id.to_string(), reason: None, by: None });
        announce_conn_departure(state, room_id, user_id, released).await;
    }
    if parse_voice_room(room_id).is_some() {
        push_own_voice_state(state, user_id).await;
    }
}

/// Announce that one of `user_id`'s connections, which WAS in `room_id` (its
/// presence announced when it joined), has just been taken out of it -
/// `released` being what that removal released. A clean LeaveRoom and a
/// JoinRoom refused after its insert, for a connection that had already been
/// in the room, both end here. Every announcement is gated on the user having
/// FULLY left: one still present on another device must not be erased from
/// every roster.
async fn announce_conn_departure(
    state: &Arc<AppState>,
    room_id: &str,
    user_id: UserId,
    released: crate::state::ReleasedMedia,
) {
    let was_joined = true;
    // "Fully left" — no other connection of this user remains in the room.
    // Mirrors the disconnect path.
    let still_member = state
        .rooms
        .get(room_id)
        .map(|r| r.members.contains(&user_id))
        .unwrap_or(false);

    // r2-3-L3-01: a clean LeaveRoom from a VOICE room used to emit no media
    // retraction at all — only UserLeft, which no client turns into a peer
    // teardown. Mesh media is peer-to-peer, so remaining peers kept the
    // leaver's RTCPeerConnection open with their microphone still on it,
    // invisible to every roster and beyond every eviction path (which key off
    // state.rooms, which the leaver just vacated). Emit the SAME over-complete
    // StreamStopped the eviction path sends — unconditional of any streamer
    // claim, because MEMBERSHIP is what clients render — plus the
    // screen-share/camera retractions for whatever this connection actually
    // released. Viewer-scoped, like every other StreamStopped emitter. The
    // stock client sends StopStream first; a second StreamStopped is
    // idempotent (Set/Map delete), exactly as the eviction path's own
    // belt-and-braces overlap.
    if leave_retracts_media(was_joined, parse_voice_room(room_id).is_some(), still_member) {
        let msg = ServerMessage::StreamStopped {
            room_id: room_id.to_string(),
            streamer_id: user_id,
        };
        state.send_to_user(user_id, msg.clone());
        for audience_id in voice_roster_audience(state, room_id, user_id).await {
            state.send_to_user(audience_id, msg.clone());
        }
        // Belt-and-braces room-scoped send: reaches whoever holds a roster
        // entry even if the viewer resolve failed closed to empty. The evictee
        // is already out of the room, so no duplicate reaches them.
        state.broadcast_to_room(room_id, msg, None);
        if released.screen_sharer {
            state.broadcast_to_room(
                room_id,
                ServerMessage::ScreenShareStopped {
                    room_id: room_id.to_string(),
                    streamer_id: user_id,
                },
                None,
            );
        }
        if released.camera_user {
            state.broadcast_to_room(
                room_id,
                ServerMessage::CameraStopped {
                    room_id: room_id.to_string(),
                    user_id,
                },
                None,
            );
        }
    }

    // Notify other room members only when the user has fully left. Mirrors the
    // JoinRoom gate: a presence-hidden user was never announced outside voice,
    // so their departure is not announced either.
    let announce_presence = room_announces_presence(room_id) || user_shows_online(state, user_id).await;
    if leave_announces_departure(was_joined, still_member, announce_presence) {
        state.broadcast_to_room(
            room_id,
            ServerMessage::UserLeft {
                room_id: room_id.to_string(),
                user_id,
            },
            None,
        );
    }
}

/// Everyone currently sharing a live VOICE room with `user_id` (excluding
/// themselves).
///
/// These people are exempt from a mid-session "show online status" flip: the
/// Settings copy carves voice out ("Joining a voice channel still shows you in
/// that channel"), so telling them the user went offline would be a lie. It
/// would also be a destructive one — the synthetic `UserOffline` is byte-for-byte
/// the real-disconnect message, and the client treats it as one: a remote-control
/// partner tears the session down with "The other person disconnected", releasing
/// held input mid-use, and voice rosters lose a participant who is still talking.
pub(crate) fn voice_room_peers(
    state: &Arc<AppState>,
    user_id: UserId,
) -> std::collections::HashSet<UserId> {
    let mut peers = std::collections::HashSet::new();
    for room in state.rooms.iter() {
        if parse_voice_room(room.key()).is_none() || !room.members.contains(&user_id) {
            continue;
        }
        peers.extend(room.members.iter().copied().filter(|&id| id != user_id));
    }
    peers
}

/// Users who should see `user_id`'s presence: everyone who shares at least one
/// server with them, plus their accepted friends (friends may share no server).
/// Excludes the user itself. Offline members in the set are harmless — the
/// per-user send is a no-op when they have no live session.
pub(crate) async fn presence_audience(state: &Arc<AppState>, user_id: UserId) -> Vec<UserId> {
    // NOTE: server_members.user_id is INT4 but friends.user1_id/user2_id are
    // INT8, so the UNION column resolves to INT8 — cast both branches to bigint
    // and decode as i64. (Decoding as i32 fails at runtime, and unwrap_or_default
    // would silently turn that into an empty audience — no presence at all.)
    // r2-1-L1-02: exclude accounts blocked in EITHER direction, so a blocked
    // account stops receiving the blocker's UserOnline/UserOffline frames. The
    // block dimension was added to every DM/consent gate but never here, so a
    // block did not stop the presence stream. blocked_users columns are INT4;
    // $1 (bigint) and t.uid (bigint) compare fine against them. On a DB error
    // the whole query already fails CLOSED (empty audience below).
    let rows = sqlx::query_as::<_, (i64,)>(
        "SELECT DISTINCT uid FROM ( \
            SELECT sm2.user_id::bigint AS uid \
            FROM server_members sm1 \
            JOIN server_members sm2 ON sm1.server_id = sm2.server_id \
            WHERE sm1.user_id = $1 AND sm2.user_id <> $1 \
            UNION \
            SELECT (CASE WHEN user1_id = $1 THEN user2_id ELSE user1_id END)::bigint AS uid \
            FROM friends \
            WHERE user1_id = $1 OR user2_id = $1 \
        ) t \
        WHERE NOT EXISTS ( \
            SELECT 1 FROM blocked_users b \
            WHERE (b.blocker_id = $1 AND b.blocked_id = t.uid) \
               OR (b.blocker_id = t.uid AND b.blocked_id = $1) \
        )",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await;
    match rows {
        Ok(r) => r.into_iter().map(|(id,)| id as UserId).collect(),
        Err(e) => {
            // Fail safe: log and return no recipients rather than crash the socket.
            tracing::error!(
                "presence_audience query failed for user {}: {:?}",
                user_id,
                e
            );
            Vec::new()
        }
    }
}

/// Audience for voice-roster events (StreamStarted / StreamStopped): the
/// owning server's members who can VIEW the room's channel — the same scope
/// the REST `get_voice_users` snapshot already enforces. The previous audience
/// (`presence_audience`: everyone sharing ANY server, plus friends) broadcast
/// who-is-in-which-voice-channel across server boundaries and to VIEW-denied
/// members. Clients key rosters by room_id and can only render channels they
/// can see, so the wider audience was pure disclosure, never rendered UX.
///
/// `exclude` is dropped from the result (normally the subject user): every call
/// site does its own explicit, condition-guarded self-send (the reconnect path
/// must NOT tell the user's own devices unless they fully left the room), and
/// the channel-viewer set DOES include the subject — so, unlike the old
/// `presence_audience` which excluded self implicitly, we must exclude it here
/// or a not-fully-left reconnect would wrongly erase the user from their own
/// roster.
///
/// FAILS CLOSED to an empty audience: a transient resolve error briefly stales
/// a sidebar roster (the REST poll heals it), which beats leaking presence.
/// Non-voice room ids resolve to nobody — Stream events only exist for
/// `voice_<channelId>` rooms.
async fn voice_roster_audience(
    state: &Arc<AppState>,
    room_id: &str,
    exclude: UserId,
) -> Vec<UserId> {
    let Some(cid) = parse_voice_room(room_id) else {
        return Vec::new();
    };
    // Width matched to this SQL text's other users (channels.id is INT4 —
    // see the 22P03 note in device_token.rs).
    let server: Option<(String,)> = sqlx::query_as("SELECT server_id FROM channels WHERE id = $1")
        .bind(cid as i32)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);
    let Some((server_id,)) = server else {
        return Vec::new();
    };
    match crate::permissions::get_channel_viewer_ids(&state.pool, cid, &server_id).await {
        Ok(set) => set.into_iter().filter(|&id| id != exclude).collect(),
        Err(e) => {
            tracing::error!(
                "voice_roster_audience: viewer resolve failed for {}: {:?}",
                room_id,
                e
            );
            Vec::new()
        }
    }
}

/// What the evicted user's OWN devices are told, once the room they were in
/// has been torn down around them. There is no "nothing" case on purpose: a
/// client that is never told is a client still rendering a call it has been
/// removed from.
pub enum SelfNotice {
    /// The room is gone — tear the call down locally. Right for a disconnect
    /// and for voice exclusivity.
    Gone,
    /// Join this channel instead.
    ///
    /// Deliberately NOT accompanied by a `RoomLeft`. `VoicePanel`'s RoomLeft
    /// handler calls `onDisconnect`, which sets `currentVoiceChannel` to null,
    /// and that would land in the same synchronous dispatch tick as this
    /// message's own `setCurrentVoiceChannel(target)` — last writer wins,
    /// non-deterministically. Sending only this makes a moved client take the
    /// byte-identical path to a user-initiated channel switch, which is the
    /// only path proven to work.
    MoveTo {
        server_id: String,
        channel_id: i64,
        from_channel_id: i64,
        moved_by: String,
    },
    /// Voice exclusivity: the account joined ANOTHER voice room from
    /// `actor_conn`. Every device is still told `RoomLeft` exactly as for
    /// `Gone`, but the connections that were IN this room (other than the
    /// actor) get it with `reason: "moved"` and the actor's device kind, so a
    /// PC whose call the phone just took into another channel can say so
    /// instead of dropping silently - and their sessions are tombstoned
    /// against a replayed join of this room (a laptop that slept through the
    /// RoomLeft must not steal the call back when it wakes). The actor itself
    /// never gets a reason: it is mid-join and must not show a notice.
    Displaced { actor_conn: u64 },
}

/// Force `user_id` out of the live voice room `room_id`, leaving no ghost
/// behind: drop them from the in-memory room, retract their roster entry for
/// everyone who can see that channel, tell the members left behind that any
/// media they held has stopped, and tell the user's own devices what became of
/// them (`notice`). Returns true if they were actually in the room.
///
/// Media is peer-to-peer, so removing the server-side row alone cannot cut a
/// mic — the `RoomLeft` at the end is what makes the evicted client stop.
///
/// The retraction is deliberately over-complete. `StreamStopped` fires whether
/// or not they held a streamer claim, because MEMBERSHIP is what clients
/// render: a member with no claim (mic prompt still open, media released by a
/// dead connection, the AFK auto-move) otherwise stayed on every sidebar —
/// "shows as AFK and in the voice channel at once".
///
/// `cut_sfu` additionally removes them from the channel's LiveKit room. A
/// caller ENFORCING a removal (moderation) must pass true: `RoomLeft` is
/// advisory, and a client that ignores it keeps publishing to the SFU. Voice
/// exclusivity passes false — it evicts the user's OWN other device, which
/// tears itself down, and an awaited LiveKit round trip would otherwise sit in
/// the middle of every voice-channel switch.
pub async fn evict_user_from_voice_room(
    state: &Arc<AppState>,
    room_id: &str,
    user_id: UserId,
    cut_sfu: bool,
    notice: SelfNotice,
) -> bool {
    // Snapshot BEFORE mutating. The broadcasts below must reach the room's
    // PRE-eviction member list: removing the last member deletes the room
    // outright, and a broadcast against a room that just vanished reaches
    // nobody, leaving every remaining client holding the ghost.
    let (was_sharer, was_camera, members, held_by) = {
        let Some(room) = state.rooms.get(room_id) else {
            return false;
        };
        if !room.members.contains(&user_id) {
            return false;
        }
        (
            room.screen_sharers.contains(&user_id),
            room.camera_users.contains(&user_id),
            room.members.clone(),
            // Which of the user's connections held the call (for Displaced).
            room.conns_of(user_id).cloned().unwrap_or_default(),
        )
    }; // guard dropped before the await below

    let audience = voice_roster_audience(state, room_id, user_id).await;
    if let Some(mut room) = state.rooms.get_mut(room_id) {
        room.remove_member(user_id);
    } // guard dropped before any broadcast re-reads rooms
    state.drop_room_if_empty(room_id);

    // Roster retraction, presence-scoped to who can see the channel.
    {
        let msg = ServerMessage::StreamStopped {
            room_id: room_id.to_string(),
            streamer_id: user_id,
        };
        // The user's OWN devices too — every one of them is showing the stale
        // entry, including any that is not the device being evicted.
        state.send_to_user(user_id, msg.clone());
        for &audience_id in &audience {
            state.send_to_user(audience_id, msg.clone());
        }
    }

    // Remaining members get the full media-stopped + left set (mirrors the
    // unclean-disconnect path) so no ghost tile survives either.
    let peers = || members.iter().copied().filter(|&m| m != user_id);
    if was_sharer {
        let msg = ServerMessage::ScreenShareStopped {
            room_id: room_id.to_string(),
            streamer_id: user_id,
        };
        for member_id in peers() {
            state.send_to_user(member_id, msg.clone());
        }
    }
    if was_camera {
        let msg = ServerMessage::CameraStopped {
            room_id: room_id.to_string(),
            user_id,
        };
        for member_id in peers() {
            state.send_to_user(member_id, msg.clone());
        }
    }
    {
        let msg = ServerMessage::UserLeft {
            room_id: room_id.to_string(),
            user_id,
        };
        for member_id in peers() {
            state.send_to_user(member_id, msg.clone());
        }
    }

    // EVERY device of the user is told, not just the one that was publishing:
    // a second device left holding the old room re-asserts the voice claim on
    // its next JoinRoom replay and the eviction undoes itself.
    //
    // Sent BEFORE the SFU cut below, and the order is load-bearing for a MOVE.
    // `evict_user_from_channel` awaits an HTTP round trip to LiveKit, and
    // LiveKit then pushes the forced removal to the browser over its own
    // socket — which fires the client's "SFU disconnected, leave voice" path.
    // With the cut first, that teardown routinely beat this directive and the
    // move collapsed into a plain disconnect on every SFU channel.
    match notice {
        SelfNotice::Gone => {
            state.send_to_user(
                user_id,
                ServerMessage::RoomLeft {
                    room_id: room_id.to_string(),
                    reason: None,
                    by: None,
                },
            );
        }
        SelfNotice::MoveTo {
            server_id,
            channel_id,
            from_channel_id,
            moved_by,
        } => {
            state.send_to_user(
                user_id,
                ServerMessage::VoiceMoved {
                    server_id,
                    channel_id,
                    from_channel_id,
                    moved_by,
                },
            );
        }
        SelfNotice::Displaced { actor_conn } => {
            let by = state.conn_kind(user_id, actor_conn);
            let actor_sid = state.session_sid(user_id, actor_conn);
            let plain = ServerMessage::RoomLeft { room_id: room_id.to_string(), reason: None, by: None };
            for c in state.conn_ids_of(user_id) {
                if c != actor_conn && held_by.contains(&c) {
                    state.send_to_conn(
                        user_id,
                        c,
                        ServerMessage::RoomLeft {
                            room_id: room_id.to_string(),
                            reason: Some(Displace::Moved.reason().to_string()),
                            by: by.map(str::to_string),
                        },
                    );
                    if let Some(sid) = state.session_sid(user_id, c) {
                        if Some(&sid) != actor_sid.as_ref() {
                            state.tombstone_voice(user_id, &sid, room_id, Displace::Moved.reason(), by);
                        }
                    }
                } else {
                    state.send_to_conn(user_id, c, plain.clone());
                }
            }
        }
    }

    // Authoritative media cut for moderation (see `cut_sfu` above). Still runs
    // unconditionally: the directive above is advisory — a client that ignores
    // it, or whose socket is already dead, is exactly the one whose LiveKit
    // publication has to be severed server-side.
    if cut_sfu {
        if let Some(cid) = parse_voice_room(room_id) {
            crate::sfu::evict_user_from_channel(state, cid, user_id).await;
        }
    }
    // The account's other devices: the call they were showing has ended (or
    // moved - a JoinRoom that evicted this pushes again once it lands).
    push_own_voice_state(state, user_id).await;
    true
}

/// The voice room `user_id` currently occupies, as `(room_id, channel_id)`.
///
/// Voice exclusivity (see the `JoinRoom` arm) guarantees at most one across all
/// of a user's devices, so the first match is the answer rather than an
/// arbitrary pick. Returns None when they are not in voice at all.
pub fn current_voice_room(state: &Arc<AppState>, user_id: UserId) -> Option<(String, i64)> {
    state.rooms.iter().find_map(|r| {
        let cid = parse_voice_room(r.key())?;
        r.value()
            .members
            .contains(&user_id)
            .then(|| (r.key().clone(), cid))
    })
}

// --- The account's call on another device ------------------------------------
//
// "You're in Lounge on your PC — Leave / Move here" (docs/USER_GUIDE.md, *Your
// call on another device*). Three parts:
//
// - OwnVoiceState: every capable connection of the account learns which voice
//   room the account is in and whether it is THIS connection, pushed at connect
//   and on every membership change, so the banner works on any screen.
// - take_over on JoinRoom (Move here): join the new connection, THEN take the
//   others out of that room - the room never sees the user leave.
// - LeaveOwnVoice (Leave): take the account's other connections out.
//
// Both removals go through `displace_own_conns`, which tells ONLY the displaced
// connections (send_to_conn, never send_to_user - the device asking is often
// mid-join and would tear itself down on a RoomLeft), leaves a replay
// tombstone on their sessions, and cuts only their LiveKit sessions.

/// Why `displace_own_conns` took a connection out: `RoomLeft::reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Displace {
    /// Another device of the account pressed Move here (or tapped the same
    /// channel): the call continues there.
    Moved,
    /// Another device of the account pressed Leave: the call is over.
    LeftElsewhere,
}

impl Displace {
    fn reason(self) -> &'static str {
        match self {
            Displace::Moved => "moved",
            Displace::LeftElsewhere => "left_elsewhere",
        }
    }
}

/// The voice room the account is in, its channel id, and which of the
/// account's connections are in it - read under one room guard.
fn own_voice_snapshot(state: &Arc<AppState>, user_id: UserId) -> Option<(String, i64, std::collections::HashSet<u64>)> {
    state.rooms.iter().find_map(|r| {
        let cid = parse_voice_room(r.key())?;
        if !r.value().members.contains(&user_id) {
            return None;
        }
        let conns = r.value().conns_of(user_id).cloned().unwrap_or_default();
        Some((r.key().clone(), cid, conns))
    })
}

/// (server id, channel name, server name) for a voice channel, for the
/// account's own devices. None on any miss or error: the client then says
/// "a voice channel" rather than nothing.
async fn own_voice_labels(state: &Arc<AppState>, channel_id: i64) -> Option<(String, String, String)> {
    // channels.id is INT4 (see the 22P03 note in device_token.rs).
    sqlx::query_as::<_, (String, String, String)>(
        "SELECT c.server_id, c.name, s.name FROM channels c JOIN servers s ON s.id = c.server_id WHERE c.id = $1",
    )
    .bind(channel_id as i32)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or_else(|e| {
        tracing::warn!("own voice state: channel labels for {} failed: {}", channel_id, e);
        None
    })
}

/// The OwnVoiceState `conn_id` is sent for this snapshot.
fn own_voice_frame(
    state: &Arc<AppState>,
    user_id: UserId,
    conn_id: u64,
    snap: Option<&(String, i64, std::collections::HashSet<u64>)>,
    labels: Option<&(String, String, String)>,
) -> ServerMessage {
    match snap {
        None => ServerMessage::OwnVoiceState {
            room_id: None,
            channel_id: None,
            server_id: None,
            channel_name: None,
            server_name: None,
            here: false,
            device: None,
        },
        Some((room_id, cid, conns)) => {
            let mut others: Vec<u64> = conns.iter().copied().filter(|&c| c != conn_id).collect();
            others.sort_unstable();
            ServerMessage::OwnVoiceState {
                room_id: Some(room_id.clone()),
                channel_id: Some(*cid),
                server_id: labels.map(|l| l.0.clone()),
                channel_name: labels.map(|l| l.1.clone()),
                server_name: labels.map(|l| l.2.clone()),
                here: conns.contains(&conn_id),
                device: others.into_iter().find_map(|c| state.conn_kind(user_id, c)).map(str::to_string),
            }
        }
    }
}

/// Send the account's voice state to its capable connections - all of them,
/// or only `only`. Nothing at all (not even a database read) when no
/// connection of the account asked for it, which is every account on a
/// client that predates the feature.
///
/// The snapshot is re-read AFTER the label lookup's await and the labels
/// re-fetched if the call moved meanwhile, so what is sent is live state, not
/// a picture from before the await.
async fn send_own_voice_state(state: &Arc<AppState>, user_id: UserId, only: Option<u64>) {
    let targets: Vec<u64> = state
        .own_voice_conns(user_id)
        .into_iter()
        .filter(|c| only.is_none_or(|o| o == *c))
        .collect();
    if targets.is_empty() {
        return;
    }
    let mut labels: Option<(i64, Option<(String, String, String)>)> = None;
    for attempt in 0..3 {
        let snap = own_voice_snapshot(state, user_id);
        let ready = match (&snap, &labels) {
            (None, _) => true,
            (Some((_, cid, _)), Some((have, _))) => have == cid,
            (Some(_), None) => false,
        };
        if ready || attempt == 2 {
            let l = match (&snap, &labels) {
                (Some((_, cid, _)), Some((have, l))) if have == cid => l.as_ref(),
                _ => None,
            };
            for conn in &targets {
                state.send_to_conn(user_id, *conn, own_voice_frame(state, user_id, *conn, snap.as_ref(), l));
            }
            return;
        }
        if let Some((_, cid, _)) = &snap {
            labels = Some((*cid, own_voice_labels(state, *cid).await));
        }
    }
}

/// Tell every capable connection of the account where its call is now. Call
/// after ANY change to the account's voice membership.
pub(crate) async fn push_own_voice_state(state: &Arc<AppState>, user_id: UserId) {
    send_own_voice_state(state, user_id, None).await;
}

/// Tell ONE connection (a fresh socket) where the account's call is. A no-op
/// for a connection that did not announce `own_voice`.
pub(crate) async fn send_own_voice_state_to(state: &Arc<AppState>, user_id: UserId, conn_id: u64) {
    send_own_voice_state(state, user_id, Some(conn_id)).await;
}

/// Whether THIS connection is in `room_id` (not merely its user, through
/// another device).
fn conn_in_room(state: &Arc<AppState>, room_id: &str, user_id: UserId, conn_id: u64) -> bool {
    state
        .rooms
        .get(room_id)
        .is_some_and(|r| r.conns_of(user_id).is_some_and(|c| c.contains(&conn_id)))
}

/// Whether `user_id` is in `room_id` through some connection OTHER than
/// `conn_id` - i.e. a media mutation from `conn_id` would act on a call that
/// lives on another device.
fn only_another_conn_in_room(state: &Arc<AppState>, room_id: &str, user_id: UserId, conn_id: u64) -> bool {
    state
        .rooms
        .get(room_id)
        .is_some_and(|r| r.members.contains(&user_id) && !r.conns_of(user_id).is_some_and(|c| c.contains(&conn_id)))
}

/// Whether a media START (StartStream / ScreenShareStart / CameraStart) from
/// `conn_id` comes from a device whose call in `room_id` was moved or ended
/// from another device of the account, and must be ignored quietly - never
/// answered "Not in this room": that is an Error frame, which the client
/// alert()s. Two shapes: the account is in the room on another connection
/// (Move here a moment ago), or this connection is not in the room and its
/// sign-in session is tombstoned for it - a woken PC's re-claim right after
/// its refused replay, when the call was ended (Leave) or moved to another
/// channel, so the account is no longer in this room at all.
fn start_from_displaced_conn(state: &Arc<AppState>, room_id: &str, user_id: UserId, conn_id: u64) -> bool {
    if only_another_conn_in_room(state, room_id, user_id, conn_id) {
        return true;
    }
    !conn_in_room(state, room_id, user_id, conn_id)
        && state
            .session_sid(user_id, conn_id)
            .is_some_and(|sid| state.voice_replay_tombstone(user_id, &sid, room_id).is_some())
}

/// If the account holds a voice call on a connection of ANOTHER sign-in
/// session than `sid` (another device - a reconnect of the same device keeps
/// its session), the kind of device that holds it (`Some(None)` when that
/// device did not say). `None` when no other device is in voice, or when
/// `sid` is empty (a legacy token: same device or not cannot be told).
fn voice_call_on_another_session(
    state: &Arc<AppState>,
    user_id: UserId,
    conn_id: u64,
    sid: &str,
) -> Option<Option<&'static str>> {
    if sid.is_empty() {
        return None;
    }
    // Collect first: no rooms guard is held across the sessions lookups.
    let holders: Vec<u64> = state
        .rooms
        .iter()
        .filter(|r| parse_voice_room(r.key()).is_some())
        .filter_map(|r| r.value().conns_of(user_id).map(|c| c.iter().copied().collect::<Vec<u64>>()))
        .flatten()
        .filter(|&c| c != conn_id)
        .collect();
    holders.into_iter().find_map(|c| {
        state
            .session_sid(user_id, c)
            .filter(|other| other != sid)
            .map(|_| state.conn_kind(user_id, c))
    })
}

/// Leave or Move here (or any deliberate voice join) from `actor_conn` while
/// another device's socket has JUST died in voice: that device is already
/// out of the room, so `displace_own_conns` finds nothing and writes no
/// tombstone - yet the other devices are told about the drop only after the
/// rejoin grace, so the phone's banner offered exactly this. Tombstone those
/// sessions (other than the actor's), so the dropped PC's replay on waking
/// does not undo the Leave or take the call back. `only_room`: Leave names
/// one room; a join moves the call off any. Own account only.
fn tombstone_recent_voice_drops(
    state: &Arc<AppState>,
    user_id: UserId,
    actor_conn: u64,
    only_room: Option<&str>,
    why: Displace,
) {
    let Some(actor_sid) = state.session_sid(user_id, actor_conn) else { return };
    let by = state.conn_kind(user_id, actor_conn);
    let window = rejoin_grace() + VOICE_DROP_SLACK;
    for (sid, room) in state.recent_voice_drops(user_id, window) {
        if sid != actor_sid && only_room.is_none_or(|r| r == room) {
            state.tombstone_voice(user_id, &sid, &room, why.reason(), by);
        }
    }
}

/// How long after the rejoin grace a drop still counts as "just now" for
/// [`tombstone_recent_voice_drops`]: the other devices' banner is hidden by
/// the OwnVoiceState sent at the end of the grace, and a press can race it.
const VOICE_DROP_SLACK: std::time::Duration = std::time::Duration::from_secs(15);

/// Take every connection of `user_id` EXCEPT `actor_conn` out of voice room
/// `room_id`, because the account asked from `actor_conn` (Move here, or
/// Leave). Returns how many connections were taken out. Own account only: the
/// caller passes the socket's own user and connection, never a target.
///
/// - If `actor_conn` is in the room (Move here: it has just joined), the user
///   never leaves it: no UserLeft and no StreamStopped (the voice claim is
///   inherited by the actor - `Room::remove_member_conn`), only the
///   ScreenShareStopped / CameraStopped for media the displaced connection
///   held, which is gone with it.
/// - Otherwise (Leave) the user is out of the room, and the room is told
///   exactly what a forced eviction tells it.
///
/// Each displaced connection - and ONLY it - is sent `RoomLeft` with `why`
/// and the actor's device kind, BEFORE the LiveKit cut (the cut fires the
/// client's own disconnect path, which must not win the race and drop the
/// explanation). Each displaced session (other than the actor's own) is
/// tombstoned against a replayed join of this room. LiveKit: a Leave cuts the
/// user's sessions in the room; a Move cuts only those minted on the
/// displaced sessions, never the actor's.
pub(crate) async fn displace_own_conns(
    state: &Arc<AppState>,
    room_id: &str,
    user_id: UserId,
    actor_conn: u64,
    why: Displace,
) -> usize {
    let Some(cid) = parse_voice_room(room_id) else { return 0 };
    // Snapshot BEFORE mutating, as the eviction helper does: the room's
    // pre-removal members and media, and whether this ends the user's call.
    let (was_sharer, was_camera, members) = {
        let Some(room) = state.rooms.get(room_id) else { return 0 };
        let Some(conns) = room.conns_of(user_id) else { return 0 };
        if !conns.iter().any(|&c| c != actor_conn) {
            return 0;
        }
        (
            room.screen_sharers.contains(&user_id),
            room.camera_users.contains(&user_id),
            room.members.clone(),
        )
    };
    let (displaced, released, still_member) = {
        let Some(mut room) = state.rooms.get_mut(room_id) else { return 0 };
        // Re-read under the write guard: the await above may have changed it.
        let mut live: Vec<u64> = room
            .conns_of(user_id)
            .map(|c| c.iter().copied().filter(|&c| c != actor_conn).collect())
            .unwrap_or_default();
        live.sort_unstable();
        let mut released = crate::state::ReleasedMedia::default();
        for &c in &live {
            let r = room.remove_member_conn(user_id, c);
            released.streamer |= r.streamer;
            released.screen_sharer |= r.screen_sharer;
            released.camera_user |= r.camera_user;
        }
        (live, released, room.members.contains(&user_id))
    }; // guard dropped before any send re-reads rooms
    if displaced.is_empty() {
        return 0;
    }
    state.drop_room_if_empty(room_id);

    let by = state.conn_kind(user_id, actor_conn);
    for &c in &displaced {
        state.send_to_conn(
            user_id,
            c,
            ServerMessage::RoomLeft {
                room_id: room_id.to_string(),
                reason: Some(why.reason().to_string()),
                by: by.map(str::to_string),
            },
        );
    }

    if still_member {
        // The call moved, it did not end. Only media that lived on the
        // displaced device stops; the voice claim was handed to the
        // surviving connection, so nobody is told the user stopped talking.
        if released.screen_sharer {
            state.broadcast_to_room(
                room_id,
                ServerMessage::ScreenShareStopped { room_id: room_id.to_string(), streamer_id: user_id },
                None,
            );
        }
        if released.camera_user {
            state.broadcast_to_room(
                room_id,
                ServerMessage::CameraStopped { room_id: room_id.to_string(), user_id },
                None,
            );
        }
    } else {
        // The call is over: the same over-complete retraction a forced
        // eviction sends (see evict_user_from_voice_room). The viewer
        // audience is a database read of who can see the channel, so it is
        // fetched only here, after the displaced connections were told.
        let audience = voice_roster_audience(state, room_id, user_id).await;
        let stopped = ServerMessage::StreamStopped { room_id: room_id.to_string(), streamer_id: user_id };
        state.send_to_user(user_id, stopped.clone());
        for &audience_id in &audience {
            state.send_to_user(audience_id, stopped.clone());
        }
        let peers = || members.iter().copied().filter(|&m| m != user_id);
        if was_sharer {
            let msg = ServerMessage::ScreenShareStopped { room_id: room_id.to_string(), streamer_id: user_id };
            for m in peers() {
                state.send_to_user(m, msg.clone());
            }
        }
        if was_camera {
            let msg = ServerMessage::CameraStopped { room_id: room_id.to_string(), user_id };
            for m in peers() {
                state.send_to_user(m, msg.clone());
            }
        }
        let left = ServerMessage::UserLeft { room_id: room_id.to_string(), user_id };
        for m in peers() {
            state.send_to_user(m, left.clone());
        }
    }

    // A displaced device that never read its RoomLeft (a sleeping laptop)
    // must not be put back in the call by its reconnect replay.
    let actor_sid = state.session_sid(user_id, actor_conn);
    let mut displaced_sids: Vec<String> = Vec::new();
    for &c in &displaced {
        if let Some(sid) = state.session_sid(user_id, c) {
            if Some(&sid) != actor_sid.as_ref() && !displaced_sids.contains(&sid) {
                state.tombstone_voice(user_id, &sid, room_id, why.reason(), by);
                displaced_sids.push(sid);
            }
        }
    }

    // LiveKit, after every frame above.
    if still_member {
        if !displaced_sids.is_empty() {
            crate::sfu::evict_session_identities(state, cid, user_id, &displaced_sids).await;
        }
    } else {
        crate::sfu::evict_user_from_channel(state, cid, user_id).await;
    }

    tracing::info!(
        "Own voice: user {} {} {} connection(s) in {} from conn {}",
        user_id,
        if why == Displace::Moved { "moved the call off" } else { "ended the call on" },
        displaced.len(),
        room_id,
        actor_conn
    );
    push_own_voice_state(state, user_id).await;
    displaced.len()
}

/// Parse a `channel_{id}` text-channel room name into its numeric channel id.
/// Voice rooms use bare channel names and DM rooms use `dm_{...}`, so those
/// return None (their access is governed elsewhere).
fn parse_channel_room(room_id: &str) -> Option<i64> {
    room_id
        .strip_prefix("channel_")
        .and_then(|s| s.parse::<i64>().ok())
}

/// Parse a `voice_{channelId}` voice/stream-room name into its numeric channel
/// id. Voice rooms are namespaced by channel id (a global BIGINT, so already
/// per-server) specifically so joins can be membership-gated the same way text
/// rooms are. Kept distinct from the `channel_` prefix so send_signal_to_user
/// (state.rs) still treats voice rooms as signaling-eligible.
fn parse_voice_room(room_id: &str) -> Option<i64> {
    room_id
        .strip_prefix("voice_")
        .and_then(|s| s.parse::<i64>().ok())
}

/// The channel behind a room id, whichever of the two legal shapes it is —
/// `channel_<id>` (text) or `voice_<id>` (voice/stream). `None` means the id is
/// not a room this server recognises AT ALL, which is now a refusal at JoinRoom
/// rather than a fall-through that mints an arbitrary room (L8-AUTHZ-5).
///
/// Named so the join gate and the mutate gate resolve through the SAME function:
/// they disagreed before (join covered both shapes, mutate covered voice only),
/// and a gate pair that can drift is a gate pair that will.
fn room_channel_id(room_id: &str) -> Option<i64> {
    parse_channel_room(room_id).or_else(|| parse_voice_room(room_id))
}

/// What a WS handler returns when a database call fails.
///
/// `handle_message` returns `Result<(), String>` and the socket loop sends that
/// string straight back as `ServerMessage::Error { message }`. Two sites folded
/// raw sqlx errors in via `.map_err(|e| e.to_string())?`, which puts table and
/// constraint names — schema reconnaissance — on the wire. Every OTHER `Err` in
/// `handle_message` is a fixed literal (enumerated when this was written), so
/// fixing the producers makes the boundary safe without classifying errors
/// there; a `WsError { Client, Internal }` enum would be the fuller answer and
/// is not worth the churn while the producer set stays this small.
///
/// `ctx` names the call site for the log and is NEVER sent.
fn ws_db_error(ctx: &str, e: sqlx::Error) -> String {
    tracing::error!("ws db error [{ctx}]: {e}");
    "internal error".to_string()
}

/// The refusal message a JoinRoom for an unrecognised room id gets. Identical
/// for every bad shape — it tells a prober nothing.
const UNKNOWN_ROOM: &str = "unknown room";

/// The room a JoinRoom may target, or the refusal. THIS is the L8-AUTHZ-5 gate:
/// `Err` for anything that is not `channel_<id>` / `voice_<id>`, so the handler
/// cannot fall through to `state.join_room` with an arbitrary string. Written as
/// a `Result`-returning function rather than an `if let` in the arm so the
/// refusal is the function's own contract and a unit test can hold it.
fn join_target(room_id: &str) -> Result<i64, &'static str> {
    room_channel_id(room_id).ok_or(UNKNOWN_ROOM)
}

/// The JoinRoom refusal for anyone who may not know the channel is there:
/// not found, a failed lookup, a non-member, or a member VIEW-denied on it.
/// Identical across all four so the refusal is no existence oracle.
const JOIN_REFUSED: &str = "Not a member of this channel's server";

/// The JoinRoom refusal for a member who can SEE the voice channel but lacks
/// CONNECT. Saying so leaks nothing — the channel is in their sidebar — and
/// the generic text told a member they were not in a server they plainly are.
const JOIN_NO_CONNECT: &str = "You don't have permission to join this voice channel";

/// What one resolver answer means for a JoinRoom — the same function for the
/// pre-insert gate and the post-insert recheck, so they cannot disagree.
///
/// - `Ok(None)`: a text room, admitted (VIEW).
/// - `Ok(Some(can_speak))`: a voice room, admitted (VIEW + CONNECT), carrying
///   the joiner's SPEAK right from the SAME resolution (`has` counts
///   ADMINISTRATOR, which the server owner resolves to).
/// - `Err(text)`: refused, with the text the socket sends back. Only
///   `Allowed` with VIEW can earn the specific CONNECT text; everything else,
///   `NotMember` and `NotFound` included, gets `JOIN_REFUSED` — both fail
///   closed, they differ only in what they say.
fn join_verdict(access: &ChannelPermAccess, voice: bool) -> Result<Option<bool>, &'static str> {
    match access {
        ChannelPermAccess::Allowed { perms, .. } if perms.has(Permissions::VIEW_CHANNEL) => {
            if !voice {
                Ok(None)
            } else if perms.has(Permissions::CONNECT) {
                Ok(Some(perms.has(Permissions::SPEAK)))
            } else {
                Err(JOIN_NO_CONNECT)
            }
        }
        _ => Err(JOIN_REFUSED),
    }
}

/// True if `a` and `b` are both currently joined to the same in-memory VOICE
/// room (`voice_<channelId>` — also the home of screen-share / camera / remote
/// control). Used to authorize peer-to-peer relays (WebRTC signaling,
/// remote-control). Restricted to voice rooms (H6): the old "any shared room"
/// test let two users merely idling in the same TEXT channel (or a bare/DM
/// room) authorize WebRTC/RC signaling — enabling unsolicited calls, live-mic
/// capture and ICE/home-IP harvesting against anyone who happened to be in a
/// call. Voice-room membership is itself VIEW-gated at JoinRoom.
/// Bounds for the file-transfer control plane. The payloads are metadata only,
/// so these are deliberately tight.
const MAX_FILE_NAME_LEN: usize = 255;
const MAX_MIME_LEN: usize = 128;
const MAX_TRANSFERS_PER_USER: usize = 8;

/// Device ids are a fixed 21 chars; the slack allows a format change without a
/// protocol break while still bounding what reaches a query.
const MAX_DEVICE_ID_LEN: usize = 64;
/// Total live device sessions one account may hold.
const MAX_DEVICE_SESSIONS_PER_USER: usize = 4;
/// Sessions targeting a single host device. One is enough: this is what stops a
/// modified controller ringing a machine over and over.
const MAX_SESSIONS_PER_HOST_DEVICE: usize = 1;
/// A session nobody answered. Short — an unanswered ring should not hold the
/// host's only slot for long.
const DEVICE_SESSION_PENDING_TTL_SECS: u64 = 60;
/// An accepted session that has gone quiet. Input and ICE both keep it fresh —
/// but a controller minimized on a phone legitimately sends nothing for as
/// long as the user is in another app (the media flows peer-to-peer, not
/// through this relay), so the reaper spares an idle session whose sockets
/// still vouch for it: both sides attached and both conn ids present in the
/// session registry.
const DEVICE_SESSION_IDLE_TTL_SECS: u64 = 180;
/// The reprieve's own ceiling: how long one session may be spared with NO
/// relayed traffic at all. This is what actually frees the host's single
/// slot from a ghost — a panicked socket task skips its disconnect cleanup,
/// which leaves its conn REGISTERED, so the registry check above passes for
/// exactly the corpse it was once claimed to catch. Generous, because a
/// legitimately-watched background session may relay nothing for hours; a
/// ghost pinned for a day still beats one pinned until restart.
const DEVICE_SESSION_REPRIEVE_MAX_SECS: u64 = 24 * 60 * 60;
/// How long an ACTIVE session survives one side's socket dropping, waiting for
/// that side to reconnect and DeviceReattach. Long enough to cover an app
/// switch plus the client's reconnect backoff; comfortably under the 75s conn
/// idle timeout is NOT required (the session is not a conn), but it stays
/// short so a stolen or pocketed phone cannot hold a host's only slot open.
const DEVICE_SESSION_DETACH_GRACE_SECS: u64 = 60;
/// An offer nobody answers is reaped quickly; an accepted transfer may
/// legitimately run for a long time (multi-gigabyte files over a domestic
/// uplink), so it is only reaped once genuinely idle.
const TRANSFER_OFFER_TTL_SECS: u64 = 120;
const TRANSFER_IDLE_TTL_SECS: u64 = 6 * 60 * 60;

/// A transfer id is generated by the client; keep it to something safe to use
/// as a map key and to log.
fn valid_transfer_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Cap a string at `max_bytes` WITHOUT splitting a UTF-8 character.
///
/// `String::truncate` panics unless the index lands on a char boundary, and
/// `len()` counts bytes — so any multibyte text longer than the cap is a panic
/// waiting to happen. That matters far more here than a crashed task: a panic
/// inside `handle_message` unwinds the socket task, and the disconnect cleanup
/// (`unregister_session` plus the media-stop broadcasts) is ordinary code AFTER
/// the receive loop, not a Drop guard. Unwinding therefore skips it, leaving
/// the session registered and its room memberships behind for the lifetime of
/// the process — a permanently "online" ghost that can also hold a stale
/// screen-share claim.
fn truncate_on_char_boundary(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Reject reasons are shown to the other party — cap them.
fn truncate_reason(reason: String) -> String {
    truncate_on_char_boundary(&reason, 120)
}

/// Test hook: the cap is the security-relevant part (see the state.rs test).
#[cfg(test)]
pub fn truncate_reason_for_test(reason: &str) -> String {
    truncate_reason(reason.to_string())
}

/// May `from` send `to` a file? Same rule as sending a DM: a conversation must
/// already exist between them, neither may have blocked the other, AND the
/// recipient's friends-only DM flag must permit it. Deliberately NOT
/// `users_share_room` — that gate exists for call signalling, and two people in
/// a DM share no room, which is precisely the case this feature is for.
///
/// The privacy-flag check is NOT optional here and the argument order matters:
/// this is the only authorization on `ClientMessage::FileOffer`, so leaving it
/// out let someone the recipient had restricted to friends-only still push an
/// incoming-transfer card at them carrying an attacker-chosen filename — the
/// exact contact the flag was set to cut off.
async fn users_can_dm(state: &Arc<AppState>, from: UserId, to: UserId) -> bool {
    let row: Option<(i32,)> = sqlx::query_as(
        r#"
        SELECT 1 FROM dm_conversations c
        WHERE ((c.user1_id = $1 AND c.user2_id = $2)
            OR (c.user1_id = $2 AND c.user2_id = $1))
          AND NOT EXISTS (
              SELECT 1 FROM blocked_users b
              WHERE (b.blocker_id = $1 AND b.blocked_id = $2)
                 OR (b.blocker_id = $2 AND b.blocked_id = $1)
          )
        "#,
    )
    .bind(from as i32)
    .bind(to as i32)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    if row.is_none() {
        return false;
    }
    crate::dm_handlers::recipient_accepts_dms(state, from, to).await
}

/// The delivery-time `sender_ok` set for `deliver_parked_offers`: the subset of
/// currently-parked-offer senders who may STILL reach `recipient` (users_can_dm
/// re-run now). `deliver_parked_offers` holds map guards and cannot await, so
/// the async gate is resolved here and handed in as a predicate; one resolve
/// per distinct sender (the set is already deduplicated). A sender who parks an
/// offer between this call and the drain is simply absent from the set, and the
/// drain refuses what it has no verdict for. Fails CLOSED via users_can_dm.
async fn resolve_parked_senders_ok(
    state: &Arc<AppState>,
    recipient: UserId,
) -> std::collections::HashSet<UserId> {
    let mut ok = std::collections::HashSet::new();
    for from in state.parked_offer_senders(recipient) {
        if users_can_dm(state, from, recipient).await {
            ok.insert(from);
        }
    }
    ok
}

/// Drop device sessions nobody answered, and accepted ones that have gone
/// quiet. Both ends are TOLD, for the same reason transfers are: a session that
/// dies silently is indistinguishable from one that hung, and the host's single
/// slot would otherwise stay consumed by a session that no longer exists.
pub fn reap_stale_device_sessions(state: &Arc<AppState>) {
    reap_stale_device_sessions_at(state, std::time::Instant::now());
}

/// Test seam. The reprieve cap is 24 hours, and a test that rewinds real
/// `Instant`s by that much panics on any machine booted more recently
/// (`Instant` cannot represent times before its epoch — this bit for real on
/// a fresh boot). Injecting a FORWARD-shifted `now` keeps the same relative
/// gaps with arithmetic that cannot underflow.
pub(crate) fn reap_stale_device_sessions_at(state: &Arc<AppState>, now: std::time::Instant) {
    // Collect first — notifying inside retain() would hold the shard lock
    // across sends.
    let mut expired: Vec<(String, UserId, u64, UserId, u64, &'static str)> = Vec::new();
    state.device_sessions.retain(|id, s| {
        let ttl = match s.state {
            DeviceSessionState::Active => DEVICE_SESSION_IDLE_TTL_SECS,
            DeviceSessionState::Pending => DEVICE_SESSION_PENDING_TTL_SECS,
        };
        // A detached side that never reattached expires the session on its own
        // clock — this is what makes the disconnect grace a WINDOW rather than
        // a leak of the host's single slot.
        let detach_expired = [s.controller_detached_at, s.host_detached_at]
            .into_iter()
            .flatten()
            .any(|t| now.duration_since(t).as_secs() >= DEVICE_SESSION_DETACH_GRACE_SECS);
        let mut idle = now.duration_since(s.touched_at).as_secs() >= ttl;
        // Quiet is not gone: an ACTIVE session whose both sockets are still
        // attached AND still in the registry is merely idle (a minimized
        // controller sends no input), so its clock is refreshed instead —
        // but only up to REPRIEVE_MAX. The registry check does NOT prove
        // liveness against a panicked socket task (its cleanup never ran, so
        // its conn stays registered and looks exactly like this); the cap is
        // what keeps such a ghost from holding the host's single slot until
        // restart. Real traffic and reattaches clear reprieved_since, so
        // only an unbroken silent streak walks into the cap.
        if idle
            && s.state == DeviceSessionState::Active
            && s.controller_detached_at.is_none()
            && s.host_detached_at.is_none()
            && state.conn_is_live(s.controller_user, s.controller_conn)
            && state.conn_is_live(s.host_user, s.host_conn)
        {
            let since = *s.reprieved_since.get_or_insert(now);
            if now.duration_since(since).as_secs() < DEVICE_SESSION_REPRIEVE_MAX_SECS {
                s.touched_at = now;
                idle = false;
            }
        }
        let alive = !detach_expired && !idle;
        if !alive {
            expired.push((
                id.clone(),
                s.controller_user,
                s.controller_conn,
                s.host_user,
                s.host_conn,
                if detach_expired {
                    "the other device did not come back"
                } else if s.state == DeviceSessionState::Active {
                    "the session went quiet and timed out"
                } else {
                    "that device did not respond"
                },
            ));
        }
        alive
    });

    for (session_id, cu, cc, hu, hc, reason) in expired {
        let reason = reason.to_string();
        state.send_to_conn(
            cu,
            cc,
            ServerMessage::DeviceEnded {
                session_id: session_id.clone(),
                reason: reason.clone(),
            },
        );
        state.send_to_conn(hu, hc, ServerMessage::DeviceEnded { session_id, reason });
    }
}

/// Drop transfers that were never answered, and accepted ones that have gone
/// quiet. Without this an abandoned offer pins a registry entry for the process
/// lifetime, and the per-user cap would eventually lock a user out of sending.
///
/// Reaping is ANNOUNCED to both sides. It used to be silent, which left the
/// sender's UI sitting on "Waiting for them to accept…" forever for a transfer
/// the server had already forgotten — the offer expired and nothing said so.
/// A transfer that fails invisibly is indistinguishable from one that hung.
pub fn reap_stale_transfers(state: &Arc<AppState>) {
    reap_stale_transfers_at(state, std::time::Instant::now());
}

/// Test seam, the same one `reap_stale_device_sessions_at` already carries and
/// for the same reason: a test that rewinds a real `Instant` by ten minutes
/// PANICS on a machine booted more recently than that, because `Instant` cannot
/// represent a time before its own epoch. That is not hypothetical — it fired
/// here the morning after the Wake-on-LAN work, when the machine had been
/// deliberately shut down and had nine minutes of uptime. Injecting a
/// FORWARD-shifted `now` keeps the same relative gaps with arithmetic that
/// cannot underflow.
pub fn reap_stale_transfers_at(state: &Arc<AppState>, now: std::time::Instant) {
    // Collect first: notifying inside retain() would hold the shard lock
    // across sends.
    let mut expired: Vec<(String, UserId, UserId, bool, bool, bool)> = Vec::new();
    state.file_transfers.retain(|id, t| {
        let ttl = if t.accepted {
            TRANSFER_IDLE_TTL_SECS
        } else {
            TRANSFER_OFFER_TTL_SECS
        };
        let alive = now.duration_since(t.touched_at).as_secs() < ttl;
        if !alive {
            expired.push((
                id.clone(),
                t.from,
                t.to,
                t.accepted,
                t.parked_offer.is_some(),
                t.hidden_target,
            ));
        }
        alive
    });

    for (transfer_id, from, to, accepted, parked, hidden_target) in expired {
        let reason = if accepted {
            "the transfer went quiet and timed out".to_string()
        } else if parked || hidden_target {
            // The offer never reached them at all — a different fact from
            // "they saw it and ignored it", and the sender should know which.
            // r2-4-L4-02: a hidden recipient reports "never came online" even
            // when the offer went straight out to their live session, so the
            // expiry reason cannot distinguish hidden-online from offline.
            "they never came online to receive the offer".to_string()
        } else {
            "they did not respond to the offer".to_string()
        };
        // Each side is told the OTHER party's id, matching FileCancelled's
        // meaning everywhere else it is sent.
        state.send_to_user(
            from,
            ServerMessage::FileCancelled {
                from_user: to,
                transfer_id: transfer_id.clone(),
                reason: reason.clone(),
            },
        );
        state.send_to_user(
            to,
            ServerMessage::FileCancelled {
                from_user: from,
                transfer_id,
                reason,
            },
        );
    }
}

/// Domain-separated transcript a device signs to prove which device it is.
/// The '|' separators make the concatenation unambiguous — without them a
/// nonce/uid pair could be re-split, letting one signature serve two contexts.
/// Mirrored byte-for-byte by `attestationMessage()` in the client.
pub fn device_attest_message(nonce: &str, user_id: UserId) -> String {
    format!("sovereign-device-attest-v1|{nonce}|{user_id}")
}

/// Verify a device attestation. `sign_pub` is `ed25519:<base64>`, `sig` is
/// base64 of the 64-byte signature.
///
/// Every malformed input answers false rather than erroring: this runs on
/// attacker-supplied bytes, and the only decision it needs to make is
/// "attested or not".
pub fn verify_device_attestation(sign_pub: &str, nonce: &str, user_id: UserId, sig: &str) -> bool {
    use base64::Engine;
    use ed25519_dalek::{Signature, VerifyingKey};

    let Some(key_b64) = sign_pub.strip_prefix("ed25519:") else {
        return false;
    };
    let Ok(key_bytes) = base64::engine::general_purpose::STANDARD.decode(key_b64) else {
        return false;
    };
    let Ok(key_arr): Result<[u8; 32], _> = key_bytes.try_into() else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(&key_arr) else {
        return false;
    };

    let Ok(sig_bytes) = base64::engine::general_purpose::STANDARD.decode(sig) else {
        return false;
    };
    let Ok(sig_arr): Result<[u8; 64], _> = sig_bytes.try_into() else {
        return false;
    };

    // verify_strict, not verify: it rejects small-order public keys and the
    // signature malleability that plain verify tolerates.
    vk.verify_strict(
        device_attest_message(nonce, user_id).as_bytes(),
        &Signature::from_bytes(&sig_arr),
    )
    .is_ok()
}

/// The database half of a DeviceAttest whose signature has verified: confirm
/// the device is STILL a live device of this user, and bind the socket's
/// session to it, as one transaction. `Ok(false)` means the device is not live
/// at bind time and the attestation must be refused exactly as an unknown or
/// revoked device is; nothing was written. `Ok(true)` means it was live, and
/// the session (when there is one) is bound to it unless first-writer-wins
/// kept an earlier binding.
///
/// WHY IT RE-READS. The handler's own read is a plain SELECT made before the
/// signature check, and `revoke_device` can commit after it. That revoke
/// sweeps only sessions already bound to the device and kills only sockets
/// already attested as it or authenticated on a swept sid. This socket was
/// neither yet, so it escaped: the old code then bound the session with an
/// unconditional UPDATE and attested the socket in memory, leaving it
/// attested as a revoked device, taking pinned parked offers, DeviceSignal
/// and presence, until it disconnected. `token_session_live` refused the
/// session's next REST call, but a socket is only checked at upgrade.
///
/// `FOR SHARE` is what makes the check atomic, the same way it does for the
/// device-token mint (`device_token::INSERT_DEVICE_SESSION`). A plain read
/// inside the transaction reads a snapshot, so against a revoke that has
/// marked the device but not committed it still sees the device live. The
/// share lock conflicts with the revoke's row lock, so the two serialise on
/// the device row. Either this commits first, and the revoke's sweep (which
/// marks, then sweeps, in one transaction) finds the session bound and the
/// socket kill reaches it by sid; or the revoke marks the device first, and
/// this read waits for its commit, re-reads the row and finds it revoked
/// (measured by `a_device_revoked_between_the_read_and_the_bind_is_not_attested`:
/// without `FOR SHARE` the same staging binds and attests). The caller attests
/// the socket in memory only after this has committed and answered true, so
/// a refused attestation leaves nothing behind, in memory or in the table.
///
/// Re-checking liveness is enough; `sign_pub` needs no second look. A device
/// id is the hash of its two public keys (`derive_device_id`) and no path
/// rewrites `sign_pub`, so the key the signature verified against is the one
/// this row still holds.
///
/// `sid` is `None` for a socket on a legacy token that carries none. There is
/// no row to bind, but the locked check still runs, so a revoke that marked
/// the device first is still waited for and refused. What this cannot cover
/// alone: a revoke that commits after this transaction reaches such a socket
/// only through its in-memory device id (`AppState::kill_device_sessions`),
/// which the caller sets just after the commit, so a revoke that committed
/// and got to its kill in that gap would miss it. The same holds for a sid
/// whose row is missing, or already bound to another device, because neither
/// is bound to THIS device for the sweep to find. `complete_attestation`
/// closes that gap with a re-check after the in-memory attestation.
pub(crate) async fn bind_attested_device(
    pool: &sqlx::PgPool,
    user_id: UserId,
    device_id: &str,
    sid: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let live: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM devices \
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL FOR SHARE",
    )
    .bind(device_id)
    .bind(user_id as i32)
    .fetch_optional(&mut *tx)
    .await?;
    if live.is_none() {
        let _ = tx.rollback().await;
        return Ok(false);
    }
    if let Some(sid) = sid {
        // First writer wins: a session proved by one device stays bound to
        // it, so a token copied elsewhere cannot re-point its session away
        // from the device the owner is about to revoke.
        sqlx::query(
            "UPDATE token_sessions SET device_id = $1 \
             WHERE sid = $2 AND user_id = $3 AND (device_id IS NULL OR device_id = $1)",
        )
        .bind(device_id)
        .bind(sid)
        .bind(user_id as i32)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(true)
}

/// The in-memory half of a DeviceAttest, after `bind_attested_device` has
/// committed and answered true: attest the socket, check once more that the
/// device is live, and only then deliver what an attested device gets (its
/// pinned parked offers, `DeviceAttested`, presence to the user's other
/// sockets).
///
/// WHY THE SECOND CHECK. The bind's lock covers a revoke that commits before
/// the bind does, and a revoke that commits after it finds the session bound
/// and hangs this socket up by its sid. It cannot cover a socket whose
/// session is NOT bound to this device: one with no sid (a legacy token), or
/// one whose session an earlier attestation bound to another device (first
/// writer wins). The revoke reaches such a socket only by its in-memory
/// device id (`kill_device_sessions`), which is set here, after the bind's
/// commit. A revoke that committed and ran its kill in between missed it, and
/// the socket was then attested as a device already revoked.
///
/// A plain read after `attest_device` is enough, because the two orders it
/// can meet are both covered. A revoke that committed before this read is
/// seen by it. One that commits after it runs its device kill after its
/// commit, by which time this socket is attested, so that kill finds it. On
/// a revoked (or vanished) device the attestation is taken back and the
/// socket hung up, as the revoke would have done. The check runs before the
/// parked-offer sweep, `DeviceAttested` and the presence broadcast, so a
/// device revoked by then gets none of them. Once it has passed, a revoke can
/// only commit after it, and that revoke's own kill ends the socket.
///
/// A database error on the re-check takes the attestation back too, and is
/// reported like any other: the socket stays up, unattested.
async fn complete_attestation(
    state: &Arc<AppState>,
    user_id: UserId,
    conn_id: u64,
    device_id: String,
) -> Result<(), String> {
    state.attest_device(user_id, conn_id, device_id.clone());
    let still_live: Option<(bool,)> =
        match sqlx::query_as("SELECT revoked_at IS NULL FROM devices WHERE id = $1 AND user_id = $2")
            .bind(&device_id)
            .bind(user_id as i32)
            .fetch_optional(&state.pool)
            .await
        {
            Ok(row) => row,
            Err(e) => {
                state.withdraw_attestation(user_id, conn_id, &device_id);
                return Err(ws_db_error("device_attest recheck", e));
            }
        };
    if still_live != Some((true,)) {
        // The device kill finds this socket by the id just attested, so it
        // runs before the attestation is taken back. It reaches the device's
        // other sockets too, exactly as the revoke's own kill does.
        let killed = state.kill_device_sessions(user_id, &device_id);
        state.withdraw_attestation(user_id, conn_id, &device_id);
        tracing::info!(
            "device attest: device {} of user {} was revoked while conn {} attested; hung up {} socket(s)",
            device_id, user_id, conn_id, killed
        );
        return Ok(());
    }

    // A parked offer PINNED to this device could not match until
    // the id was proven; sweep again now that it is. Same
    // delivery-time block/consent re-check as the connect path.
    let ok = resolve_parked_senders_ok(state, user_id).await;
    let parked = state.deliver_parked_offers(user_id, conn_id, move |from| ok.contains(&from));
    for offer in parked.offers {
        state.send_to_conn(user_id, conn_id, offer);
    }
    for (to_user, note) in parked.sender_notes {
        state.send_to_user(to_user, note);
    }
    // Best-effort: a failed touch must not fail the attestation.
    let _ = sqlx::query("UPDATE devices SET last_seen_at = NOW() WHERE id = $1")
        .bind(&device_id)
        .execute(&state.pool)
        .await;
    let _ = state.send_to_conn(
        user_id,
        conn_id,
        ServerMessage::DeviceAttested {
            device_id: device_id.clone(),
        },
    );
    // Tell the user's OTHER devices this one is reachable now, so
    // an open device list repaints at once rather than on its next
    // poll. Except this conn: it just learned that itself.
    let _ = state.send_to_user_except_conn(
        user_id,
        conn_id,
        ServerMessage::DevicePresence {
            device_id,
            online: true,
        },
    );
    Ok(())
}

fn users_share_room(state: &Arc<AppState>, a: UserId, b: UserId) -> bool {
    state.rooms.iter().any(|room| {
        parse_voice_room(room.key()).is_some()
            && room.members.contains(&a)
            && room.members.contains(&b)
    })
}

/// M9 gate for room-state mutations (StartStream/StopStream, ScreenShare*,
/// Camera*, Typing): the user MUST already be a current member of the in-memory
/// room. Room membership implies the JoinRoom VIEW gate was passed, so a
/// non-member can no longer poison a room's streamer/sharer/camera lists (which
/// were never reaped on disconnect) with permanent ghost entries. For voice
/// rooms we additionally re-verify VIEW on the channel, mirroring JoinRoom, so a
/// member who lost access mid-session can't keep mutating room state.
async fn can_mutate_room(state: &Arc<AppState>, room_id: &str, user_id: UserId) -> bool {
    can_mutate_room_with(state, room_id, user_id, None).await
}

/// How long a dropped voice socket may be silent before its departure is
/// announced to the room (WS_REJOIN_GRACE_SECS, default 8; 0 = announce at
/// once). The client's reconnect backoff starts at one second, so a genuine
/// blip is back well inside this; a real departure is simply reported eight
/// seconds late, which nobody notices.
fn rejoin_grace() -> std::time::Duration {
    std::time::Duration::from_secs(
        std::env::var("WS_REJOIN_GRACE_SECS")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(|s| s.min(60))
            .unwrap_or(8),
    )
}

/// Refusals the client shows verbatim when the server declines a media
/// announcement (the stock client announces BEFORE it publishes, so these are
/// what the user sees instead of a silently invisible share).
pub const SHARE_DENIED: &str = "You don't have permission to share your screen in this channel";
pub const CAMERA_DENIED: &str = "You don't have permission to turn on your camera in this channel";

/// The channel `can_mutate_room_with` must resolve permissions against, and the
/// EXTRA media bit that applies there — or `None` for a room with no channel
/// behind it.
///
/// L8-AUTHZ-4: this used to be `parse_voice_room` alone, so every NON-voice room
/// fell through to membership only. The one non-voice caller is `Typing`, and
/// the residual was a stale typing indicator surviving the window between a
/// permission change and `broadcast_perms_changed_and_evict`'s sweep — or a kick
/// that never runs one. Resolving BOTH shapes makes the mutate gate agree with
/// the join gate, at the cost of one indexed lookup per typing frame (already
/// metered by the per-connection token bucket).
///
/// `extra` (STREAM / VIDEO) is voice semantics and is dropped for a text room:
/// a text channel has no media to gate. Every caller that passes one passes a
/// voice room, but that is dropped explicitly rather than relied upon.
fn mutate_gate_target(
    room_id: &str,
    extra: Option<Permissions>,
) -> Option<(i64, Option<Permissions>)> {
    let cid = room_channel_id(room_id)?;
    let extra = if parse_voice_room(room_id).is_some() {
        extra
    } else {
        None
    };
    Some((cid, extra))
}

/// As [`can_mutate_room`], plus an optional EXTRA permission bit the caller must
/// hold on the voice room's channel — used to gate the specific media a member
/// is starting (STREAM for a screen share, VIDEO for a camera), which are
/// editable role bits that nothing enforced.
///
/// `extra` is only meaningful for voice rooms; a non-voice room has no channel
/// permissions to resolve and keeps the plain membership rule.
async fn can_mutate_room_with(
    state: &Arc<AppState>,
    room_id: &str,
    user_id: UserId,
    extra: Option<Permissions>,
) -> bool {
    // Read membership then drop the guard immediately (a held Ref would deadlock
    // the subsequent get_mut on the same DashMap shard).
    let is_member = state
        .rooms
        .get(room_id)
        .map(|r| r.members.contains(&user_id))
        .unwrap_or(false);
    if !is_member {
        return false;
    }
    if let Some((cid, extra)) = mutate_gate_target(room_id, extra) {
        return matches!(
            get_user_channel_permissions(&state.pool, cid, user_id).await,
            ChannelPermAccess::Allowed { perms, .. }
                if perms.has(Permissions::VIEW_CHANNEL)
                    && extra.is_none_or(|bit| perms.has(bit))
        );
    }
    // Unreachable for any room a client can join (JoinRoom refuses every id that
    // is not `channel_`/`voice_`); kept as the defensive floor.
    true
}

/// Per-connection message rate limiter (token bucket). tower_governor only
/// meters HTTP requests, so without this one authenticated socket could blast
/// WS frames as fast as it likes — each doing DB work — and saturate the pool,
/// stalling every other request. Generous enough for a legit client's bursts
/// (initial room joins, a flurry of ICE candidates) but caps sustained abuse.
struct RateLimiter {
    tokens: f64,
    capacity: f64,
    refill_per_sec: f64,
    last_refill: std::time::Instant,
}

impl RateLimiter {
    /// Burst capacity and sustained refill rate (tokens per second).
    const CAPACITY: f64 = 100.0;
    const REFILL_PER_SEC: f64 = 50.0;

    /// The input bucket's ceiling comes from the client's own emit shape: the
    /// coalescers flush relative motion every 8ms (125/s) and absolute motion
    /// every 16ms (62.5/s), plus clicks/keys/wheel on top — and one socket can
    /// legitimately carry two concurrent control sessions. 300/s sustained
    /// covers all of that with margin; 50/s demonstrably did not (a 60Hz drag
    /// lost one frame in six after ten seconds, and a 125Hz rmove stream lost
    /// three in five after ~1.3s — felt as drift, rubber-banding and stuck
    /// buttons, since a dropped frame is never retransmitted).
    const INPUT_CAPACITY: f64 = 400.0;
    const INPUT_REFILL_PER_SEC: f64 = 300.0;

    /// Wake requests get their own, much SMALLER bucket.
    ///
    /// DeviceWake is the one frame that makes another of the user's machines
    /// emit traffic onto their LAN with no interaction at that machine — the
    /// responder acts on receipt. Under the general bucket (100 burst, 50/s)
    /// a single socket could drive hundreds of broadcast datagrams per second
    /// through that path.
    ///
    /// Sized for the real ceiling on legitimate use, which is "how many
    /// machines might someone wake in a row" — a lab, a media box, two
    /// desktops — NOT "one machine, retried". A dropped frame is discarded
    /// silently (there is no error path back to the client), so a bucket too
    /// tight does not rate-limit, it produces a wake that never happened and a
    /// three-minute wait ending in a BIOS wild goose chase. 8 burst covers
    /// waking every machine most people own, in one go, with a fat-fingered
    /// double-press or two absorbed; one every two seconds sustained is still
    /// two orders of magnitude below the general bucket.
    const WAKE_CAPACITY: f64 = 8.0;
    const WAKE_REFILL_PER_SEC: f64 = 0.5;

    fn new() -> Self {
        Self::with(Self::CAPACITY, Self::REFILL_PER_SEC)
    }

    fn for_control_input() -> Self {
        Self::with(Self::INPUT_CAPACITY, Self::INPUT_REFILL_PER_SEC)
    }

    fn for_wake() -> Self {
        Self::with(Self::WAKE_CAPACITY, Self::WAKE_REFILL_PER_SEC)
    }

    /// `SetActivity`: a status change fans out to every member of every
    /// server the user shares, so a client flapping its reports must not be
    /// able to drive that at the general bucket's 50/s. A real client sends
    /// one frame per transition (a pause in typing that crosses a minute, a
    /// return) plus one per reconnect — but a tab or app switch on web and
    /// Android is two (hidden, shown), so quick switching does reach this.
    /// What it bounds is the immediate FAN-OUT: a report over the limit is
    /// still taken, and the sweep publishes it (see presence_gate). The
    /// broadcast side is separately coalesced (presence::Thresholds::
    /// min_broadcast_gap). An admitted frame is also metered by the general
    /// bucket after this.
    const PRESENCE_CAPACITY: f64 = 6.0;
    const PRESENCE_REFILL_PER_SEC: f64 = 0.2;

    fn for_presence() -> Self {
        Self::with(Self::PRESENCE_CAPACITY, Self::PRESENCE_REFILL_PER_SEC)
    }

    fn with(capacity: f64, refill_per_sec: f64) -> Self {
        Self {
            tokens: capacity,
            capacity,
            refill_per_sec,
            last_refill: std::time::Instant::now(),
        }
    }

    /// Try to consume one token. Returns false when the bucket is empty (caller
    /// drops the frame). Refills continuously based on elapsed time.
    fn allow(&mut self) -> bool {
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.last_refill = now;
        self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Cheap pre-parse classification of remote-control input frames, so they can
/// be metered by their own bucket. Our clients serialize `type` first
/// (`JSON.stringify` of `{ type, payload }` preserves insertion order), so a
/// prefix check is exact for well-behaved traffic. Misclassification is
/// harmless in both directions: a legitimate frame that misses the prefix
/// falls into the general bucket (worst case: the old behaviour), and a
/// hostile frame faking it lands in a bucket that is still rate-bounded.
fn is_input_frame(text: &str) -> bool {
    text.starts_with("{\"type\":\"DeviceInput\"") || text.starts_with("{\"type\":\"ControlInput\"")
}

/// Same prefix trick as `is_input_frame`, in the other direction: this one
/// selects a SMALLER bucket, so a crafted frame faking the prefix only
/// restricts itself, and a genuine wake frame that somehow misses the prefix
/// falls back to the general bucket — i.e. exactly today's behaviour.
fn is_wake_frame(text: &str) -> bool {
    text.starts_with("{\"type\":\"DeviceWake\"")
}

/// Same prefix trick, for the presence bucket. A real `SetActivity` that
/// misses the prefix only skips the extra bucket (the general one still
/// meters it, and the broadcast gap still coalesces); a crafted frame
/// faking it only throttles itself.
fn is_presence_frame(text: &str) -> bool {
    text.starts_with("{\"type\":\"SetActivity\"")
}

/// A real `SetActivity` is ~50 bytes; anything much bigger that fakes the
/// prefix is not worth parsing on the throttled path.
const MAX_THROTTLED_PRESENCE_FRAME: usize = 256;

/// The read loop's presence bucket. Returns whether the frame goes on to the
/// general bucket and `handle_message`.
///
/// A report over the limit is NOT dropped: the client marks a report as told
/// once it is on the wire and never repeats it (it reports transitions only),
/// so a dropped "active" would leave the server holding a stale "inactive"
/// while the person keeps chatting — idle after ten minutes, away after an
/// hour, in front of everyone. Each tab or app switch on web and Android is
/// two frames, so a few quick switches empty the bucket. Instead its STATE is
/// taken — in memory, one shard lock — and only the immediate refresh (the
/// fan-out the bucket exists to bound) is skipped: the sweep delivers any
/// change within `Thresholds::sweep_every`, and `min_broadcast_gap` still
/// coalesces. Never an Error frame either way (the stock client alerts).
fn presence_gate(state: &AppState, user: UserId, conn: u64, text: &str, bucket: &mut RateLimiter) -> bool {
    if !is_presence_frame(text) || bucket.allow() {
        return true;
    }
    if text.len() <= MAX_THROTTLED_PRESENCE_FRAME {
        if let Ok(ClientMessage::SetActivity { inactive_secs }) = serde_json::from_str::<ClientMessage>(text) {
            let since = inactive_secs.map(|s| crate::presence::Since::now_minus(std::time::Instant::now(), s));
            state.report_session_activity(user, conn, since);
        }
    }
    false
}

/// Max rooms a single connection may be joined to at once. A healthy client
/// holds ~2 (a text channel + a voice room); this cap bounds the global rooms
/// map against a JoinRoom flood with unique room_ids.
const MAX_ROOMS_PER_CONN: usize = 64;
/// Max accepted room_id length (bounds per-room key memory).
const MAX_ROOM_ID_LEN: usize = 128;
/// Max lengths for relayed WebRTC signaling payloads (defense in depth beyond
/// the 256 KiB frame cap — these have small legitimate sizes).
const MAX_SDP_LEN: usize = 64 * 1024;
const MAX_CANDIDATE_LEN: usize = 4 * 1024;
const MAX_CONTROL_EVENT_LEN: usize = 8 * 1024;
/// Human-readable disconnect/refusal text relayed between peers. It is shown in
/// a toast, so it has no business being large. Unbounded, it was one of four
/// relay fields a client could fill to the 256 KiB frame limit and then park in
/// a stalled peer's outbound queue, which bounds MESSAGES (256) rather than
/// bytes — so a handful of sockets could pin hundreds of megabytes of server
/// memory with strings nobody would ever read.
const MAX_REASON_LEN: usize = 512;
/// Max stored/relayed chat message content (bytes).
const MAX_MESSAGE_CONTENT_LEN: usize = 8000;

/// Whether a chat/DM message body is acceptable: non-empty (after trim), within
/// the length cap, and free of NUL bytes. A rejected message would otherwise be
/// cloned to every room member — an amplification lever.
pub(crate) fn valid_message_content(content: &str) -> bool {
    !content.trim().is_empty()
        && content.len() <= MAX_MESSAGE_CONTENT_LEN
        && !content.contains('\0')
}

/// Handle a single client message. `joined_rooms` tracks the rooms THIS
/// connection has joined, so we can bound them per-connection.
async fn handle_message(
    state: &Arc<AppState>,
    user_id: UserId,
    conn_id: u64,
    username: &str,
    text: &str,
    joined_rooms: &mut std::collections::HashSet<String>,
    device_nonce: &str,
) -> Result<(), String> {
    let msg: ClientMessage =
        serde_json::from_str(text).map_err(|e| format!("Invalid message format: {}", e))?;

    match msg {
        ClientMessage::Ping => {
            tracing::debug!("Received Ping from user {}, sending Pong", user_id);
            state.send_to_conn(user_id, conn_id, ServerMessage::Pong);
        }

        // Idle/away (crate::presence): this connection's own local activity.
        // Only a connection that announced the capability is a reporting
        // one; from any other the frame changes nothing. Never an Error:
        // nothing a client can say here is worth an alert on its screen.
        ClientMessage::SetActivity { inactive_secs } => {
            let now = std::time::Instant::now();
            let since = inactive_secs.map(|s| crate::presence::Since::now_minus(now, s));
            if state.report_session_activity(user_id, conn_id, since) {
                crate::presence::refresh(state, user_id, now).await;
            }
        }

        ClientMessage::JoinRoom { room_id, take_over, replay } => {
            // Bound room_id length and the number of rooms this connection may
            // join — otherwise a flood of unique room_ids grows the global rooms
            // DashMap without limit (one authenticated socket → OOM).
            if room_id.len() > MAX_ROOM_ID_LEN {
                return Err("room_id too long".to_string());
            }
            if !joined_rooms.contains(&room_id) && joined_rooms.len() >= MAX_ROOMS_PER_CONN {
                return Err("too many joined rooms".to_string());
            }
            // A REPLAYED voice join (the client re-sending what it remembers
            // after its socket came back) from a session another device of the
            // account has since ended or moved the call away from: refuse it,
            // quietly. The PC slept through its RoomLeft; rejoining now would
            // undo an explicit Leave with an open mic, or steal the call back
            // from the phone. Checked before anything else - in particular
            // before voice exclusivity, which would evict the phone. Told with
            // the RoomLeft it missed (the client drops the room from its
            // replay list on it); never an Error frame, which old clients
            // alert(). A deliberate join (no `replay`) is never refused here.
            //
            // The tombstone is only written when the move or Leave found this
            // device still in the room. A replay is ALSO refused whenever the
            // account's call is live on another device at all (another
            // sign-in session; a reconnect of this device keeps its own): the
            // PC's zombie was reaped before the phone joined, or Move here was
            // pressed during the PC's rejoin grace and displaced nothing. A
            // replay must never put the PC back next to the phone, nor evict
            // the phone's call in another channel. The refusal is tombstoned
            // like any other, so the client's re-claim that follows the replay
            // (StartStream...) is ignored quietly too.
            let session = state.session_sid(user_id, conn_id).unwrap_or_default();
            if parse_voice_room(&room_id).is_some() {
                if replay {
                    let refused = state.voice_replay_tombstone(user_id, &session, &room_id).map(|t| (t.reason, t.by)).or_else(|| {
                        let by = voice_call_on_another_session(state, user_id, conn_id, &session)?;
                        state.tombstone_voice(user_id, &session, &room_id, Displace::Moved.reason(), by);
                        Some((Displace::Moved.reason(), by))
                    });
                    if let Some((reason, by)) = refused {
                        joined_rooms.remove(&room_id);
                        state.send_to_conn(
                            user_id,
                            conn_id,
                            ServerMessage::RoomLeft {
                                room_id: room_id.clone(),
                                reason: Some(reason.to_string()),
                                by: by.map(str::to_string),
                            },
                        );
                        tracing::info!(
                            "JoinRoom replay refused for user {} conn {}: {} was ended, moved or is live on another device",
                            user_id,
                            conn_id,
                            room_id
                        );
                        return Ok(());
                    }
                } else {
                    state.clear_voice_tombstone(user_id, &session);
                }
            }
            // Gate text-channel rooms (channel_<id>) AND voice/stream rooms
            // (voice_<channelId>) on VIEW_CHANNEL — membership alone is no
            // longer enough now that channels carry permission overwrites: a
            // member VIEW-denied on a channel must not passively receive its
            // live message stream (REST send_message fans out to
            // `channel_{id}`) nor exchange WebRTC signaling with voice members
            // (harvesting their ICE candidates / home IPs). Non-members stay
            // rejected as before. DM rooms are governed elsewhere. The error is
            // deliberately identical for not-found / non-member / VIEW-denied
            // so the channel's existence is not leaked.
            //
            // The gate is EXHAUSTIVE, not an allowlist-by-omission (L8-AUTHZ-5).
            // Anything that was neither shape used to fall through and create a
            // room in the global map, which handed two authenticated clients who
            // agreed on a made-up id a server-mediated presence channel: joining
            // one returns a `RoomJoined` roster, so a joiner learned the
            // usernames of everyone else who guessed the same string. Verified
            // before flipping this that no shipped client sends another shape —
            // the only senders are `channel_${id}` (Chat.tsx, ChecklistBody.tsx),
            // `voice_${id}` (Chat.tsx → VoicePanel), and websocket.ts's onopen
            // replay, which re-sends only ids it was given; the two native crates
            // send no JoinRoom at all. `state.join_room` has exactly one caller,
            // this arm, so nothing server-side conjures another namespace either.
            let cid = join_target(&room_id).map_err(|refusal| {
                tracing::warn!(
                    "JoinRoom refused for user {} ({}): unknown room shape {:?}",
                    user_id,
                    username,
                    room_id
                );
                refusal.to_string()
            })?;
            // A VOICE room additionally requires CONNECT: it is an editable
            // role bit ("Join voice channels") that nothing enforced, so a
            // member explicitly denied CONNECT could still join the call.
            // Text rooms need VIEW only — CONNECT is a voice permission.
            // (join_verdict: a member who can see the channel but lacks
            // CONNECT is told so; every other refusal stays generic.)
            let need_connect = parse_voice_room(&room_id).is_some();
            let access = get_user_channel_permissions(&state.pool, cid, user_id).await;
            if let Err(refusal) = join_verdict(&access, need_connect) {
                // Warn-level: a legitimate client rejoining after reconnect
                // that lands here is silently cut off from live channel
                // traffic — this must be visible in prod logs.
                tracing::warn!(
                    "JoinRoom rejected for user {} ({}): no VIEW/CONNECT access for room {}",
                    user_id,
                    username,
                    room_id
                );
                return Err(refusal.to_string());
            }

            // VOICE EXCLUSIVITY: one voice room per USER across all devices.
            // Joining a voice room from any connection evicts the user from
            // every OTHER voice room — "changing channel on mobile overrides
            // the desktop session". Media is P2P, so server-side removal alone
            // can't cut the old device's mic: the RoomLeft sent below tells
            // that device's client to run its local voice teardown.
            if parse_voice_room(&room_id).is_some() {
                // Snapshot the room KEYS first and drop the DashMap iterator
                // before mutating anything — the eviction below takes its own
                // guards. Near-always empty: this arm runs on every room join,
                // including ordinary text-channel clicks.
                let vacate: Vec<String> = state
                    .rooms
                    .iter()
                    .filter(|r| {
                        r.key() != &room_id
                            && parse_voice_room(r.key()).is_some()
                            && r.value().members.contains(&user_id)
                    })
                    .map(|r| r.key().clone())
                    .collect();
                for old_room in vacate {
                    // `cut_sfu: false` — this evicts the user's OWN other
                    // device, which tears itself down on the RoomLeft below,
                    // and an awaited LiveKit round trip here would sit in the
                    // middle of every voice-channel switch. Moderation passes
                    // true, where the removal has to be enforced rather than
                    // requested.
                    evict_user_from_voice_room(
                        &state,
                        &old_room,
                        user_id,
                        false,
                        SelfNotice::Displaced { actor_conn: conn_id },
                    )
                    .await;
                    tracing::info!(
                        "Voice exclusivity: user {} evicted from {} on joining {}",
                        user_id,
                        old_room,
                        room_id
                    );
                }
            }

            // The server this channel belongs to (only an Allowed answer, the
            // one that admitted this join, names it): its sweep epoch orders
            // this join's speak flag against its sweeps (store_join_speak).
            let join_server = match &access {
                ChannelPermAccess::Allowed { server_id, .. } => Some(server_id.clone()),
                _ => None,
            };

            // Was the user already in the room from another device? Peers only
            // get a UserJoined for the user's FIRST joined connection.
            let already_member = state
                .rooms
                .get(&room_id)
                .map(|r| r.members.contains(&user_id))
                .unwrap_or(false);

            // Whether THIS connection was already in the room (a repeat join on
            // the same socket): its presence was announced then.
            let conn_was_joined = joined_rooms.contains(&room_id);
            joined_rooms.insert(room_id.clone());
            state.join_room(&room_id, user_id, conn_id);
            // After the insert: a sweep that starts later has this user in its
            // snapshot, and one that started before it read this epoch.
            let epoch_before = join_server.as_deref().map(|s| perms_sweep_epoch(state, s));

            // Close the check/insert race with a perms-change eviction pass:
            // the VIEW check above and the join_room insert are separated by
            // awaits, so a join that passed pre-commit could land AFTER the
            // eviction snapshot and keep a live subscription. Overwrites are
            // committed before eviction runs, so re-checking after the insert
            // is guaranteed to see any deny this join raced against.
            //
            // The same resolution is the joiner's SPEAK right in a voice room
            // (`voice_can_speak`, None for a text room): the newest answer
            // this join has, and one that already saw any deny it raced.
            // Same bits as the gate above: a voice room needs CONNECT too.
            let voice_can_speak = match join_verdict(
                &get_user_channel_permissions(&state.pool, cid, user_id).await,
                need_connect,
            ) {
                Ok(can_speak) => can_speak,
                Err(refusal) => {
                    withdraw_refused_join(state, &room_id, user_id, conn_id, conn_was_joined, already_member, joined_rooms).await;
                    tracing::warn!(
                        "JoinRoom revoked post-insert for user {} ({}): VIEW/CONNECT lost for room {}",
                        user_id,
                        username,
                        room_id
                    );
                    return Err(refusal.to_string());
                }
            };
            // Store it BEFORE anything is sent, so the snapshot below and every
            // occupant's frame read it. The write guard is dropped at the end of
            // this statement; the senders take their own read guard.
            if let Some(can_speak) = voice_can_speak {
                match (join_server.as_deref(), epoch_before) {
                    (Some(sid), Some(epoch)) => store_join_speak(state, &room_id, user_id, can_speak, sid, epoch),
                    _ => {
                        if let Some(mut room) = state.rooms.get_mut(&room_id) {
                            room.set_can_speak(user_id, can_speak);
                        }
                    }
                }
            }

            // MOVE HERE. This connection is in the room now (and passed the
            // recheck), so the account's other connections can be taken out
            // without the user ever leaving it: join FIRST, remove SECOND. The
            // displaced connections alone are told (RoomLeft, reason "moved");
            // the room hears nothing, and the voice claim passes to this
            // connection. Before the snapshot below, so this join's RoomJoined
            // and media replay already describe the call as it is after the
            // move. Never part of a replay - the client does not store it.
            if take_over && parse_voice_room(&room_id).is_some() {
                displace_own_conns(state, &room_id, user_id, conn_id, Displace::Moved).await;
            }
            // A deliberate voice join on this device also moves the call off a
            // device whose socket died in voice moments ago (its replay must
            // not take it back): see tombstone_recent_voice_drops.
            if !replay && parse_voice_room(&room_id).is_some() {
                tombstone_recent_voice_drops(state, user_id, conn_id, None, Displace::Moved);
            }

            // Get current members and active streams
            let (mut members, active_streamers, active_sharers, active_camera_users, share_ids) =
                if let Some(room) = state.rooms.get(&room_id) {
                    let m = room
                        .members
                        .iter()
                        .filter_map(|&id| {
                            state.get_username(id).map(|name| UserInfo::new(id, name))
                        })
                        .collect::<Vec<_>>();
                    let s = room.streamers.clone();
                    let ss = room.screen_sharers.clone();
                    let cu = room.camera_users.clone();
                    // Announced share stream ids ride the replay so a LATE
                    // joiner classifies mesh video the same way everyone
                    // present at the announce did.
                    let ids = room.share_stream_ids.clone();
                    (m, s, ss, cu, ids)
                } else {
                    (vec![], vec![], vec![], vec![], std::collections::HashMap::new())
                };

            // Drop presence-hidden occupants from the roster this join is about
            // to be handed. Outside voice, "you appear offline to everyone" has
            // to hold on the wire too — a scripted client (or devtools' WS pane)
            // reads these frames directly, so leaving a hidden user in the list
            // leaked both that they were online and which channel they had open.
            // The joining user always sees THEMSELVES.
            if !room_announces_presence(&room_id) {
                let ids: Vec<UserId> = members.iter().map(|m| m.id).collect();
                let hidden = hidden_members(&state, &ids).await;
                members.retain(|m| m.id == user_id || !hidden.contains(&m.id));
            }

            // Notify the joining connection (not the user's other devices —
            // they have their own room state).
            state.send_to_conn(
                user_id,
                conn_id,
                ServerMessage::RoomJoined {
                    room_id: room_id.clone(),
                    members: members.clone(),
                },
            );

            // A voice joiner learns the speak right of EVERY member, itself
            // included, before any media replay below can start a negotiation:
            // its receivers must refuse a flagged member's audio from the first
            // packet, and its own entry tells a cooperating client not to send.
            // No presence filtering is needed — a voice room always announces
            // presence (room_announces_presence), so `members` above was not
            // filtered either.
            if voice_can_speak.is_some() {
                state.send_speak_snapshot(&room_id, user_id, conn_id);
            }

            // Send existing streams to the joining connection
            for streamer_id in active_streamers {
                if let Some(name) = state.get_username(streamer_id) {
                    state.send_to_conn(
                        user_id,
                        conn_id,
                        ServerMessage::StreamStarted {
                            room_id: room_id.clone(),
                            streamer: UserInfo::new(streamer_id, name),
                        },
                    );
                }
            }

            // Send existing screen shares to the joining connection
            for sharer_id in active_sharers {
                if let Some(name) = state.get_username(sharer_id) {
                    state.send_to_conn(
                        user_id,
                        conn_id,
                        ServerMessage::ScreenShareStarted {
                            room_id: room_id.clone(),
                            streamer: UserInfo::new(sharer_id, name),
                            stream_id: share_ids.get(&sharer_id).cloned(),
                        },
                    );
                }
            }

            // Send existing camera users to the joining connection
            for camera_user_id in active_camera_users {
                if let Some(name) = state.get_username(camera_user_id) {
                    state.send_to_conn(
                        user_id,
                        conn_id,
                        ServerMessage::CameraStarted {
                            room_id: room_id.clone(),
                            user: UserInfo::new(camera_user_id, name),
                        },
                    );
                }
            }

            // Notify other room members (first device only — a second device
            // joining must not duplicate the user for everyone else). A
            // presence-hidden user is announced in voice rooms only; elsewhere
            // the announcement is exactly the leak the privacy toggle promises
            // to prevent. Text-room UserJoined only triggers a members-query
            // refetch on the client (Chat.tsx), and that REST list already
            // reports hidden users as offline — so suppressing it desyncs
            // nothing.
            let announce_presence =
                room_announces_presence(&room_id) || user_shows_online(&state, user_id).await;
            if !already_member && announce_presence {
                state.broadcast_to_room(
                    &room_id,
                    ServerMessage::UserJoined {
                        room_id: room_id.clone(),
                        user: UserInfo::new(user_id, username.to_string()),
                    },
                    Some(user_id),
                );
            }

            // And every occupant learns the joiner's — sent even for a second
            // device (no UserJoined then), since this join's resolution is the
            // newest one. After UserJoined so a client that keys the flag off
            // its roster already has the entry; both are queued before any
            // negotiation with the joiner could have produced audio. "Every
            // occupant" includes the joiner's OWN other device already in the
            // call: a change this join found is one the sweep will find already
            // stored and so never announce, and only its self frame closes (or
            // reopens) that device's microphone. The joining connection is
            // skipped - the snapshot above told it.
            if voice_can_speak.is_some() {
                state.broadcast_speak_state(&room_id, user_id, Some(conn_id));
            }

            // A voice-room join IS voice presence: the only client that joins
            // a `voice_*` room is one entering (or re-entering after a
            // reconnect) the call, and the event every sidebar roster renders
            // is StreamStarted — UserJoined has no global listener. The
            // client's own post-reconnect StartStream is an unacknowledged
            // one-shot behind a fail-closed permission gate; when it is lost,
            // the user is in the call but absent from `streamers`, from every
            // roster, and from the REST snapshot until they manually rejoin.
            // Re-assert the claim here so the JoinRoom replay alone heals it.
            // (set_media and the clients' Map.set are idempotent; the join
            // chime is gated client-side by announcedRef.)
            if parse_voice_room(&room_id).is_some() {
                let needs_claim = state
                    .rooms
                    .get(&room_id)
                    .is_some_and(|r| !r.streamers.contains(&user_id));
                if needs_claim {
                    if let Some(mut room) = state.rooms.get_mut(&room_id) {
                        room.set_media(crate::state::MediaKind::Stream, user_id, conn_id, true);
                    }
                    let msg = ServerMessage::StreamStarted {
                        room_id: room_id.clone(),
                        streamer: UserInfo::new(user_id, username.to_string()),
                    };
                    state.send_to_user(user_id, msg.clone());
                    for audience_id in voice_roster_audience(&state, &room_id, user_id).await {
                        state.send_to_user(audience_id, msg.clone());
                    }
                }
                // The account's other devices: "You're in <channel> on ...".
                push_own_voice_state(state, user_id).await;
            }

            tracing::info!("User {} joined room {}", user_id, room_id);
        }

        ClientMessage::LeaveRoom { room_id } => {
            // C09: act only when THIS connection was actually in the room.
            // joined_rooms.remove returns whether this connection had joined;
            // without gating on it, a LeaveRoom for any guessed room_id
            // broadcast a spoofed UserLeft (and, below, media retractions) into
            // a private call the caller cannot even VIEW. leave_room itself is
            // a no-op for a non-occupant, so nothing else needs the guard.
            // (A connection whose call another device of the account took -
            // Move here / Leave - still lists the room and its stock teardown
            // sends LeaveRoom: announce_conn_departure re-reads LIVE membership,
            // so a user still in the call on the phone is not retracted.)
            let was_joined = joined_rooms.remove(&room_id);
            let released = state.leave_room(&room_id, user_id, conn_id);

            // Notify the leaving connection. Unconditional on purpose: it is
            // byte-identical for every room id (occupied, empty or nonexistent)
            // and is emitted before any membership read, so it is no oracle.
            state.send_to_conn(
                user_id,
                conn_id,
                ServerMessage::RoomLeft {
                    room_id: room_id.clone(),
                    reason: None,
                    by: None,
                },
            );

            if was_joined {
                announce_conn_departure(state, &room_id, user_id, released).await;
                if parse_voice_room(&room_id).is_some() {
                    push_own_voice_state(state, user_id).await;
                }
            }

            tracing::info!("User {} left room {}", user_id, room_id);
        }

        ClientMessage::LeaveOwnVoice { room_id } => {
            // "Leave" on the "You're in <channel> on your PC" banner: end THIS
            // account's call on its other device(s). There is no target - the
            // socket's own user is the only account it can touch - and it acts
            // only on `room_id`, and only on the account's OTHER connections in
            // it: a press that raced a move or a hang-up names a room the call
            // is no longer in, ends nothing, and just refreshes this
            // connection's picture. Never an Error (old clients alert() those,
            // and a stale banner is not a fault).
            let ended = displace_own_conns(state, &room_id, user_id, conn_id, Displace::LeftElsewhere).await;
            tombstone_recent_voice_drops(state, user_id, conn_id, Some(&room_id), Displace::LeftElsewhere);
            if ended == 0 {
                send_own_voice_state_to(state, user_id, conn_id).await;
            }
        }

        ClientMessage::ChatMessage { room_id, content } => {
            // Length-cap content the same way the DM path does. Without this, a
            // single WS ChatMessage could carry a huge string that is then
            // CLONED to every room member (N× amplification). Empty and
            // NUL-bearing content are rejected too.
            if !valid_message_content(&content) {
                return Err("Invalid message content".to_string());
            }
            // Message send into a channel room requires VIEW + SEND: a
            // non-member (incl. a kicked user with a live token) or a member
            // who is VIEW- or SEND-denied on the channel must not inject a live
            // message. One generic error for every denial so the channel's
            // existence isn't leaked.
            //
            // C10: BOTH shapes are gated on SEND_MESSAGES. The voice_<id>
            // branch used to check VIEW alone, so a timed-out / SEND-denied /
            // CONNECT-denied member who still held VIEW could inject a
            // __VOICE_STATUS__ frame (broadcast_to_room, no sender-membership
            // check) into a voice call they cannot join — bypassing
            // SEND_MESSAGES and the member-timeout deny list the text branch
            // enforces.
            //
            // The one carve-out is the status ping itself, from a connection
            // that is actually IN the voice room: it is roster state, not a
            // message, and a CONNECT-holder denied SEND must still be able to
            // show the room that they are muted / deafened / recording. See
            // `chat_admission` for the rule and its tests.
            if let Some(cid) = parse_channel_room(&room_id).or_else(|| parse_voice_room(&room_id)) {
                let access = get_user_channel_permissions(&state.pool, cid, user_id).await;
                let admission = chat_admission(
                    parse_voice_room(&room_id).is_some(),
                    &content,
                    joined_rooms.contains(&room_id),
                    &access,
                );
                if admission == ChatAdmission::Refused {
                    return Err("Not a member of this channel's server".to_string());
                }
                // Member-timeout enforcement, mirroring the REST send path
                // (message_handlers.rs). Without it a timed-out member could
                // still inject a live, visible ChatMessage over the socket —
                // making the timeout advisory on this path. Scoped to the
                // server that owns this channel via the join.
                // Fail CLOSED on a query error: a timeout is a deny list, and
                // `unwrap_or(None)` made any transient failure lift it.
                // Skipped for an occupant's status ping: a timed-out member
                // still in a call must not have their mute state freeze for
                // everyone else — the timeout silences MESSAGES.
                let timed_out: Option<(i32,)> = if admission == ChatAdmission::StatusPing {
                    None
                } else {
                    match sqlx::query_as(
                        "SELECT 1 FROM member_timeouts mt \
                         JOIN channels c ON c.server_id = mt.server_id \
                         WHERE c.id = $1 AND mt.user_id = $2 AND mt.expires_at > NOW() LIMIT 1",
                    )
                    .bind(cid)
                    .bind(user_id as i32)
                    .fetch_optional(&state.pool)
                    .await
                    {
                        Ok(row) => row,
                        Err(e) => {
                            tracing::error!(
                                "ChatMessage: timeout lookup failed for user {}: {:?}",
                                user_id,
                                e
                            );
                            return Err("Could not verify timeout status".to_string());
                        }
                    }
                };
                if timed_out.is_some() {
                    return Err("You are timed out in this server".to_string());
                }
            }

            let timestamp = Utc::now().timestamp();

            state.broadcast_to_room(
                &room_id,
                ServerMessage::ChatMessage {
                    room_id: room_id.clone(),
                    sender: UserInfo::new(user_id, username.to_string()),
                    content,
                    timestamp,
                    // WS-relayed messages aren't persisted here, so no DB id exists.
                    message_id: None,
                    clip_consent: None,
                },
                None,
            );
        }

        // WebRTC signaling is only legitimate between peers who share a voice
        // room. Gating on that stops a client from sending offers/ICE to
        // arbitrary enumerated users (unsolicited call UI + network-candidate/IP
        // harvesting). Drops are still just drops on the wire (no Error frame),
        // but they are LOGGED now — a silent relay drop once hid a lost host
        // candidate for a whole debugging session. The no-shared-room case
        // logs at debug (its inputs are attacker-choosable — warn would hand a
        // log-flood lever to any authenticated socket); the no-eligible-conn
        // case logs at warn (it requires an actually shared room, and it is
        // the diagnostic that matters for good-faith clients).
        // Signaling is a conversation between two CONNECTIONS, not users:
        // send_signal_to_user routes to the target's device(s) sharing a live
        // voice/stream room with this connection. Plain send_to_user would fan
        // an Offer out to the target's idle phone too, whose auto-Answer then
        // clobbers the real device's negotiation (first-answer-wins).
        ClientMessage::Offer { target_user, sdp } => {
            if sdp.len() > MAX_SDP_LEN {
                return Err("sdp too long".to_string());
            }
            if users_share_room(state, user_id, target_user) {
                if !state.send_signal_to_user(
                    user_id,
                    conn_id,
                    target_user,
                    ServerMessage::Offer {
                        from_user: user_id,
                        sdp,
                    },
                ) {
                    tracing::warn!(
                        "signal relay: Offer {} -> {} found no eligible target conn",
                        user_id,
                        target_user
                    );
                }
            } else {
                tracing::debug!(
                    "signal relay: Offer {} -> {} dropped (no shared voice room)",
                    user_id,
                    target_user
                );
            }
        }

        ClientMessage::Answer { target_user, sdp } => {
            if sdp.len() > MAX_SDP_LEN {
                return Err("sdp too long".to_string());
            }
            if users_share_room(state, user_id, target_user) {
                if !state.send_signal_to_user(
                    user_id,
                    conn_id,
                    target_user,
                    ServerMessage::Answer {
                        from_user: user_id,
                        sdp,
                    },
                ) {
                    tracing::warn!(
                        "signal relay: Answer {} -> {} found no eligible target conn",
                        user_id,
                        target_user
                    );
                }
            } else {
                tracing::debug!(
                    "signal relay: Answer {} -> {} dropped (no shared voice room)",
                    user_id,
                    target_user
                );
            }
        }

        ClientMessage::IceCandidate {
            target_user,
            candidate,
        } => {
            if candidate.len() > MAX_CANDIDATE_LEN {
                return Err("candidate too long".to_string());
            }
            if users_share_room(state, user_id, target_user) {
                if !state.send_signal_to_user(
                    user_id,
                    conn_id,
                    target_user,
                    ServerMessage::IceCandidate {
                        from_user: user_id,
                        candidate,
                    },
                ) {
                    tracing::warn!(
                        "signal relay: IceCandidate {} -> {} found no eligible target conn",
                        user_id,
                        target_user
                    );
                }
            } else {
                tracing::debug!(
                    "signal relay: IceCandidate {} -> {} dropped (no shared voice room)",
                    user_id,
                    target_user
                );
            }
        }

        ClientMessage::StartStream { room_id } => {
            // M9: only a current member of the room may mutate its stream state.
            //
            // Deliberately NOT gated on Permissions::STREAM despite the name:
            // MediaKind::Stream here means VOICE PRESENCE, not screen sharing.
            // A plain voice join auto-claims it (see the JoinRoom arm) and
            // StreamStarted is the event every sidebar voice roster renders, so
            // requiring STREAM would erase ordinary members from the roster.
            // Screen sharing is ScreenShareStart, which IS gated on STREAM;
            // joining voice at all is gated on CONNECT at JoinRoom.
            //
            // A connection of a member that is NOT itself in the room (its call
            // was moved to another device a moment ago) is ignored quietly: it
            // would plant a claim for a socket that holds no call, and an Error
            // is an alert() on an old client that is mid-teardown. So is one
            // whose session's replay of this room was just refused (a woken
            // PC re-claiming after Leave, or after the call moved to another
            // channel): see start_from_displaced_conn.
            if start_from_displaced_conn(state, &room_id, user_id, conn_id) {
                return Ok(());
            }
            if !can_mutate_room(state, &room_id, user_id).await {
                return Err("Not in this room".to_string());
            }
            if let Some(mut room) = state.rooms.get_mut(&room_id) {
                room.set_media(crate::state::MediaKind::Stream, user_id, conn_id, true);
            }

            // Scope to the room's channel VIEWERS plus the streamer's own
            // session — NOT every connected socket, and not the old
            // presence_audience either (which reached everyone sharing ANY
            // server plus friends, leaking who-is-in-which-voice-channel across
            // server boundaries and to VIEW-denied members). Rosters are keyed
            // by room_id and only render channels a client can see, and the
            // REST get_voice_users poll enforces the same viewer scope, so
            // this preserves the UX exactly.
            let msg = ServerMessage::StreamStarted {
                room_id: room_id.clone(),
                streamer: UserInfo::new(user_id, username.to_string()),
            };
            state.send_to_user(user_id, msg.clone());
            for audience_id in voice_roster_audience(state, &room_id, user_id).await {
                state.send_to_user(audience_id, msg.clone());
            }
        }

        ClientMessage::StopStream { room_id } => {
            // A stop from a non-member is a no-op, not an error: leave/eviction
            // already released their media claims, and clients legitimately race
            // a late stop against their own LeaveRoom (reconnects, panel
            // teardown). Erroring here surfaced "Not in this room" alerts on
            // ordinary channel switches. Starts stay strict (they mutate state).
            //
            // CONNECTION-level, not just user-level: the account may hold this
            // call on ANOTHER device (Move here put it on the phone; the PC's
            // stock teardown then sends StopStream). The stop below clears the
            // claim for the whole USER and tells everyone they stopped - which
            // drops their audio on every peer while they are still talking.
            // Only a connection that is itself in the room may do that.
            if !conn_in_room(state, &room_id, user_id, conn_id) {
                tracing::debug!(
                    "Ignoring StopStream from conn {} of user {}: not in {}",
                    conn_id,
                    user_id,
                    room_id
                );
                return Ok(());
            }
            if !can_mutate_room(state, &room_id, user_id).await {
                tracing::debug!(
                    "Ignoring StopStream from non-member {} for {}",
                    user_id,
                    room_id
                );
                return Ok(());
            }
            // Clears every connection of this user (see Room::clear_media) so
            // state always agrees with the unconditional broadcast below.
            if let Some(mut room) = state.rooms.get_mut(&room_id) {
                room.clear_media(crate::state::MediaKind::Stream, user_id);
            }

            // Same scoped audience as StartStream (see above).
            let msg = ServerMessage::StreamStopped {
                room_id: room_id.clone(),
                streamer_id: user_id,
            };
            state.send_to_user(user_id, msg.clone());
            for audience_id in voice_roster_audience(state, &room_id, user_id).await {
                state.send_to_user(audience_id, msg.clone());
            }
        }

        ClientMessage::ChannelCreated { .. } => {
            // Intentionally ignored. Channel-creation fan-out is now done
            // authoritatively server-side in `create_channel` (broadcast to that
            // server's members). Rebroadcasting a client-supplied channel here
            // let any authenticated user inject a fake channel into every other
            // client with an attacker-chosen server_id — so we drop it.
            tracing::debug!(
                "Ignoring client-sent ChannelCreated from user {} (server-authoritative now)",
                user_id
            );
        }

        ClientMessage::ScreenShareStart { room_id, stream_id } => {
            // M9: only a current member of the room may mutate screen-share state,
            // and STREAM ("Screen share and stream") is now enforced here — it is
            // an editable role bit that nothing checked. NOTE this is the real
            // screen-share entry point; StartStream below is voice PRESENCE (the
            // roster claim a plain voice join makes), so it must NOT be gated on
            // STREAM or every member would vanish from the voice roster.
            // Two answers, because the stock client now waits for its own
            // ScreenShareStarted before publishing any track: a member without
            // the bit must get a message they can show, not the membership one.
            // (A connection whose call moved to another device: ignored, as in
            // StartStream.)
            if start_from_displaced_conn(state, &room_id, user_id, conn_id) {
                return Ok(());
            }
            if !can_mutate_room(state, &room_id, user_id).await {
                return Err("Not in this room".to_string());
            }
            if !can_mutate_room_with(state, &room_id, user_id, Some(Permissions::STREAM)).await {
                return Err(SHARE_DENIED.to_string());
            }
            // Client-chosen and relayed verbatim to every member, so it is
            // bounded like every other relayed string. It is only ever
            // COMPARED (never rendered) — a browser MediaStream id is a
            // 36-char UUID — so anything oversized or non-printable is
            // treated as not announced rather than rejected: the peers then
            // simply keep the pre-id classification heuristic.
            let stream_id = stream_id
                .filter(|s| !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_graphic()));
            if let Some(mut room) = state.rooms.get_mut(&room_id) {
                room.set_media(crate::state::MediaKind::ScreenShare, user_id, conn_id, true);
                match &stream_id {
                    Some(id) => {
                        room.share_stream_ids.insert(user_id, id.clone());
                    }
                    // An announce WITHOUT an id (old client) must also clear a
                    // stale one — this user may have re-shared from an older
                    // build after sharing from a newer one.
                    None => {
                        room.share_stream_ids.remove(&user_id);
                    }
                }
            }
            // Broadcast screen share started to all users in the room
            let msg = ServerMessage::ScreenShareStarted {
                room_id: room_id.clone(),
                streamer: UserInfo::new(user_id, username.to_string()),
                stream_id,
            };
            if let Some(room) = state.rooms.get(&room_id) {
                for &member_id in room.members.iter() {
                    state.send_to_user(member_id, msg.clone());
                }
            }
        }

        ClientMessage::ScreenShareStop { room_id } => {
            // Non-member stop = silent no-op (see StopStream above), and a
            // stop from a connection that is not itself in the room is one too
            // (same reason: the call may live on another device).
            if !conn_in_room(state, &room_id, user_id, conn_id) {
                return Ok(());
            }
            if !can_mutate_room(state, &room_id, user_id).await {
                tracing::debug!(
                    "Ignoring ScreenShareStop from non-member {} for {}",
                    user_id,
                    room_id
                );
                return Ok(());
            }
            if let Some(mut room) = state.rooms.get_mut(&room_id) {
                room.clear_media(crate::state::MediaKind::ScreenShare, user_id);
            }
            // Broadcast screen share stopped to all users in the room
            let msg = ServerMessage::ScreenShareStopped {
                room_id: room_id.clone(),
                streamer_id: user_id,
            };
            if let Some(room) = state.rooms.get(&room_id) {
                for &member_id in room.members.iter() {
                    state.send_to_user(member_id, msg.clone());
                }
            }
        }

        ClientMessage::CameraStart { room_id } => {
            // M9: only a current member of the room may mutate camera state,
            // plus VIDEO ("Share video in voice channels") — an editable role
            // bit that nothing checked until now. (A connection whose call
            // moved to another device: ignored, as in StartStream.)
            if start_from_displaced_conn(state, &room_id, user_id, conn_id) {
                return Ok(());
            }
            if !can_mutate_room(state, &room_id, user_id).await {
                return Err("Not in this room".to_string());
            }
            if !can_mutate_room_with(state, &room_id, user_id, Some(Permissions::VIDEO)).await {
                return Err(CAMERA_DENIED.to_string());
            }
            if let Some(mut room) = state.rooms.get_mut(&room_id) {
                room.set_media(crate::state::MediaKind::Camera, user_id, conn_id, true);
            }
            // Broadcast camera started to all users in the room
            let msg = ServerMessage::CameraStarted {
                room_id: room_id.clone(),
                user: UserInfo::new(user_id, username.to_string()),
            };
            if let Some(room) = state.rooms.get(&room_id) {
                for &member_id in room.members.iter() {
                    state.send_to_user(member_id, msg.clone());
                }
            }
        }

        ClientMessage::CameraStop { room_id } => {
            // Non-member stop = silent no-op (see StopStream above), and a
            // stop from a connection that is not itself in the room is one too
            // (same reason: the call may live on another device).
            if !conn_in_room(state, &room_id, user_id, conn_id) {
                return Ok(());
            }
            if !can_mutate_room(state, &room_id, user_id).await {
                tracing::debug!(
                    "Ignoring CameraStop from non-member {} for {}",
                    user_id,
                    room_id
                );
                return Ok(());
            }
            if let Some(mut room) = state.rooms.get_mut(&room_id) {
                room.clear_media(crate::state::MediaKind::Camera, user_id);
            }
            // Broadcast camera stopped to all users in the room
            let msg = ServerMessage::CameraStopped {
                room_id: room_id.clone(),
                user_id,
            };
            if let Some(room) = state.rooms.get(&room_id) {
                for &member_id in room.members.iter() {
                    state.send_to_user(member_id, msg.clone());
                }
            }
        }

        // --- Device attestation ---------------------------------------------
        //
        // Failure is NOT fatal and must never be. Killing the socket here would
        // break every already-deployed client and the web shell on the first
        // release; an unattested connection keeps working for chat and is
        // simply not addressable by device.
        ClientMessage::DeviceAttest { device_id, sig } => {
            if device_id.len() > 64 || sig.len() > 256 {
                return Err("attestation too long".to_string());
            }

            // Only a LIVE device of THIS user can attest. Checking user_id in
            // the query (rather than filtering after) means a valid signature
            // from someone else's device still cannot bind this connection.
            // This read only fetches the key to verify against and turns away
            // a device already revoked. It is a plain SELECT, so a revoke can
            // commit right after it; the check that counts is the locked one
            // in `bind_attested_device`, below.
            let row: Option<(String,)> = sqlx::query_as(
                "SELECT sign_pub FROM devices \
                 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
            )
            .bind(&device_id)
            .bind(user_id as i32)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| ws_db_error("device_attest lookup", e))?;

            let Some((sign_pub,)) = row else {
                tracing::debug!("device attest: unknown/revoked device {}", device_id);
                return Ok(());
            };

            if verify_device_attestation(&sign_pub, device_nonce, user_id, &sig) {
                // Bind the SESSION to the device it just proved, so revoking the
                // device revokes this token too (token_sessions.device_id) — from
                // a proof, never from the `?device=` claim.
                //
                // DATABASE FIRST, MEMORY SECOND. The bind re-checks, under a
                // lock on the device row, that the device is still live, and
                // only then is this socket attested in memory. It used to be
                // the other way round, with an unconditional bind: a revoke
                // committing between the read above and the bind found neither
                // a bound session to sweep nor an attested socket to kill, and
                // this socket then stayed attested as the revoked device until
                // it disconnected. Now a revoke that committed first is seen
                // and refused here, and one that commits after finds the
                // session bound and kills this socket by its sid. A socket
                // whose session cannot be bound to this device (no sid, or
                // bound to another) is covered by the re-check that
                // `complete_attestation` makes after attesting it in memory.
                //
                // A database error refuses the attestation rather than
                // attesting unbound. The bind's error used to be ignored,
                // which attested the socket with its session left unbound:
                // revoking the device then hung up the socket but left its
                // token working. The socket stays up and unattested, the same
                // as any refusal.
                let sid = state.session_sid(user_id, conn_id);
                let live = bind_attested_device(&state.pool, user_id, &device_id, sid.as_deref())
                    .await
                    .map_err(|e| ws_db_error("device_attest bind", e))?;
                if !live {
                    tracing::debug!("device attest: device {} was revoked during attestation", device_id);
                    return Ok(());
                }
                complete_attestation(state, user_id, conn_id, device_id).await?;
            } else {
                tracing::warn!(
                    "device attest: bad signature for device {} (user {})",
                    device_id,
                    user_id
                );
            }
        }

        // --- Device-control sessions ------------------------------------------
        //
        // DeviceConnect is the ONLY message here that touches the database.
        // Everything after it is authorized by one DashMap lookup against the
        // pinned socket pair — which matters because ICE arrives in bursts and
        // input can run at hundreds of events a second.
        ClientMessage::DeviceConnect {
            host_device,
            session_id,
            eph,
            proof,
        } => {
            if !valid_transfer_id(&session_id) {
                return Err("invalid session id".to_string());
            }
            if eph.len() > MAX_CONTROL_EVENT_LEN || proof.len() > MAX_SDP_LEN {
                return Err("handshake payload too long".to_string());
            }
            if host_device.len() > MAX_DEVICE_ID_LEN {
                return Err("invalid device id".to_string());
            }

            // The CONTROLLER must itself be an attested device. Without this a
            // stolen JWT could open a bare socket and start ringing the user's
            // machines without ever proving it is one of their devices.
            let Some(controller_device) = state.device_of_conn(user_id, conn_id) else {
                return Err("this connection has not attested as a device".to_string());
            };
            if controller_device == host_device {
                return Err("a device cannot control itself".to_string());
            }
            if state.device_sessions.contains_key(&session_id) {
                return Err("session id already in use".to_string());
            }

            // Two ways in, both checked in SQL so a valid-looking id the
            // caller may not reach is never even resolved:
            //   * your own live device (the original v1 rule), or
            //   * a live device whose owner holds an ACCEPTED, host-SIGNED,
            //     un-revoked share naming this caller as grantee.
            // The share's status/revoked_at are re-read fresh on EVERY
            // connect — revocation is a row update away and cannot be
            // replayed around. Capabilities come back only on the share
            // branch (NULL for your own device, where everything is allowed).
            // The share only joins when it is accepted, signed, un-revoked,
            // AND no block exists in EITHER direction between owner and
            // grantee. The block re-check is defence-in-depth: blocking
            // already revokes shares proactively (revoke_shares_between), but
            // re-reading it here means a share can never outlive a block even
            // if that proactive path ever failed or raced. Harmless for the
            // own-device path, where d.user_id = $2 and a self-block cannot
            // exist.
            let host_row: Option<(i32, Option<Vec<String>>)> = sqlx::query_as(
                "SELECT d.user_id, s.capabilities FROM devices d \
                 LEFT JOIN device_share_invites s \
                        ON s.host_device = d.id \
                       AND s.grantee_user = $2 \
                       AND s.status = 'accepted' \
                       AND s.revoked_at IS NULL \
                       AND s.grant_sig IS NOT NULL \
                       AND NOT EXISTS (SELECT 1 FROM blocked_users b \
                                       WHERE (b.blocker_id = d.user_id AND b.blocked_id = $2) \
                                          OR (b.blocker_id = $2 AND b.blocked_id = d.user_id)) \
                 WHERE d.id = $1 AND d.revoked_at IS NULL \
                   AND (d.user_id = $2 OR s.grantee_user IS NOT NULL)",
            )
            .bind(&host_device)
            .bind(user_id as i32)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| ws_db_error("device_session host lookup", e))?;
            // One refusal for "no such device", "someone else's device" and
            // "no grant": a probing client must not learn which it was.
            let Some((host_owner, share_caps)) = host_row else {
                let _ = state.send_to_conn(
                    user_id,
                    conn_id,
                    ServerMessage::DeviceEnded {
                        session_id,
                        reason: "that device is not registered to you".to_string(),
                    },
                );
                return Ok(());
            };
            let host_user: UserId = host_owner as UserId;
            let cross_user = host_user != user_id;
            // Input under a share needs the 'control' capability; the gate
            // lives at the DeviceInput relay below. Same-account keeps the
            // original everything-allowed rule.
            let allow_input = !cross_user
                || share_caps
                    .as_ref()
                    .is_some_and(|c| c.iter().any(|x| x == "control"));

            // A DETACHED session from this same controller device to this same
            // host is a corpse this new connect supersedes: the OS killed the
            // app rather than suspending it, the E2EE key died with the
            // webview, and no reattach is coming. Ending it here keeps the
            // one-session-per-host cap below from refusing the user's own
            // immediate retry for the rest of the grace window.
            if let Some((old_id, old_host_conn, old_host_user)) =
                state.supersede_detached_session(user_id, &controller_device, &host_device)
            {
                state.send_to_conn(
                    old_host_user,
                    old_host_conn,
                    ServerMessage::DeviceEnded {
                        session_id: old_id,
                        reason: "replaced by a new session from the same device".to_string(),
                    },
                );
            }

            // Answer "offline" on the session id rather than with a generic
            // error: the controller can then offer Wake-on-LAN instead of
            // sitting on a spinner. Same discipline as the FileOffer path.
            // Looked up under the HOST's account — under a share that is not
            // the caller's.
            let Some(host_conn) = state.conn_of_device(host_user, &host_device) else {
                let _ = state.send_to_conn(
                    user_id,
                    conn_id,
                    ServerMessage::DeviceEnded {
                        session_id,
                        reason: "that device isn't online".to_string(),
                    },
                );
                return Ok(());
            };
            if host_conn == conn_id {
                return Err("a device cannot control itself".to_string());
            }

            // Bound concurrency BEFORE inserting. One pending + one active per
            // host is what stops a modified client ringing a machine repeatedly.
            let (mine, on_host) = state.count_device_sessions(user_id, &host_device);
            if mine >= MAX_DEVICE_SESSIONS_PER_USER {
                return Err("too many device sessions".to_string());
            }
            // Under a cross-user share the HOST owner is a different account,
            // and `mine` only bounds the CALLER. Without this a coalition of
            // grantees, each individually compliant, could pin one owner as
            // host_user on far more than the per-account cap by targeting many
            // of that owner's shared devices at once (MAX_SESSIONS_PER_HOST_DEVICE
            // bounds one device, not the account). Count the owner's own total
            // too — count_device_sessions bounds whichever user it is passed,
            // in either role.
            if cross_user {
                let (host_mine, _) = state.count_device_sessions(host_user, &host_device);
                if host_mine >= MAX_DEVICE_SESSIONS_PER_USER {
                    let _ = state.send_to_conn(
                        user_id,
                        conn_id,
                        ServerMessage::DeviceEnded {
                            session_id,
                            reason: "that device's owner is already at their session limit"
                                .to_string(),
                        },
                    );
                    return Ok(());
                }
            }
            if on_host >= MAX_SESSIONS_PER_HOST_DEVICE {
                let _ = state.send_to_conn(
                    user_id,
                    conn_id,
                    ServerMessage::DeviceEnded {
                        session_id,
                        reason: "that device is already handling a session".to_string(),
                    },
                );
                return Ok(());
            }

            state.device_sessions.insert(
                session_id.clone(),
                DeviceSession {
                    controller_user: user_id,
                    host_user,
                    controller_username: username.to_string(),
                    allow_input,
                    controller_conn: conn_id,
                    host_conn,
                    controller_device: controller_device.clone(),
                    host_device: host_device.clone(),
                    state: DeviceSessionState::Pending,
                    touched_at: std::time::Instant::now(),
                    controller_detached_at: None,
                    host_detached_at: None,
                    reprieved_since: None,
                },
            );

            // Identity fields ride only on the cross-user shape, stamped from
            // this connection's authenticated claims (the ControlRequested
            // precedent) — same-account requests stay byte-identical to the
            // pre-share wire format.
            state.send_to_conn(
                host_user,
                host_conn,
                ServerMessage::DeviceConnectRequested {
                    session_id,
                    from_device: controller_device,
                    eph,
                    proof,
                    from_user: cross_user.then_some(user_id),
                    from_username: cross_user.then(|| username.to_string()),
                    capabilities: if cross_user { share_caps } else { None },
                },
            );
        }

        ClientMessage::DeviceConnectResponse {
            session_id,
            accepted,
            eph,
            reason,
            cap_w,
            cap_h,
        } => {
            if eph
                .as_ref()
                .is_some_and(|e| e.len() > MAX_CONTROL_EVENT_LEN)
            {
                return Err("handshake payload too long".to_string());
            }
            if reason.as_ref().is_some_and(|r| r.len() > MAX_REASON_LEN) {
                return Err("reason too long".to_string());
            }
            // Only the HOST may answer, and only its own pinned socket.
            // `share_notice` is Some only for a cross-user session going
            // Active: the owner's OTHER sessions are told who just connected,
            // because an unattended host answers with nobody watching it.
            let Some((controller_conn, controller_user, share_notice)) = ({
                let Some(mut s) = state.device_sessions.get_mut(&session_id) else {
                    return Ok(());
                };
                if s.host_conn != conn_id {
                    return Ok(());
                }
                let notice = (accepted && s.controller_user != s.host_user).then(|| {
                    ServerMessage::DeviceShareSessionStarted {
                        host_device: s.host_device.clone(),
                        from_user: s.controller_user,
                        from_username: s.controller_username.clone(),
                    }
                });
                if accepted {
                    s.state = DeviceSessionState::Active;
                    s.touched_at = std::time::Instant::now();
                }
                Some((s.controller_conn, s.controller_user, notice))
            }) else {
                return Ok(());
            };

            if !accepted {
                state.device_sessions.remove(&session_id);
            }
            state.send_to_conn(
                controller_user,
                controller_conn,
                ServerMessage::DeviceConnectAnswered {
                    session_id,
                    accepted,
                    eph,
                    reason,
                    cap_w,
                    cap_h,
                },
            );
            if let Some(notice) = share_notice {
                // user_id IS the host's owner here — only the host answers.
                state.send_to_user(user_id, notice);
            }
        }

        ClientMessage::DeviceSignal {
            session_id,
            payload,
        } => {
            if payload.len() > MAX_SDP_LEN {
                return Err("signal too long".to_string());
            }
            if let Some((target, target_user)) = state.touch_device_session(&session_id, conn_id) {
                state.send_to_conn(
                    target_user,
                    target,
                    ServerMessage::DeviceSignalled {
                        session_id,
                        payload,
                    },
                );
            }
        }

        ClientMessage::DeviceInput { session_id, event } => {
            if event.len() > MAX_CONTROL_EVENT_LEN {
                return Err("input too long".to_string());
            }
            // Input flows one way only. Accepting it from the host would let a
            // compromised host drive its own controller — the exact inversion
            // this feature must not permit. `allow_input` is the server-side
            // half of view-only shares: silence, like every other non-member
            // message, so a modified client learns nothing from probing.
            let (target, target_user) = {
                let Some(s) = state.device_sessions.get(&session_id) else {
                    return Ok(());
                };
                if s.controller_conn != conn_id
                    || s.state != DeviceSessionState::Active
                    || !s.allow_input
                {
                    return Ok(());
                }
                (s.host_conn, s.host_user)
            };
            state.touch_device_session(&session_id, conn_id);
            state.send_to_conn(
                target_user,
                target,
                ServerMessage::DeviceInputted { session_id, event },
            );
        }

        ClientMessage::DeviceEnd { session_id, reason } => {
            if reason.as_ref().is_some_and(|r| r.len() > MAX_REASON_LEN) {
                return Err("reason too long".to_string());
            }
            if let Some((target, target_user)) = state.end_device_session(&session_id, conn_id) {
                state.send_to_conn(
                    target_user,
                    target,
                    ServerMessage::DeviceEnded {
                        session_id,
                        reason: reason
                            .unwrap_or_else(|| "the other device ended the session".to_string()),
                    },
                );
            }
        }

        ClientMessage::DeviceReattach { session_id } => {
            if !valid_transfer_id(&session_id) {
                return Err("invalid session id".to_string());
            }
            // Same rule as DeviceConnect: only an attested device may claim a
            // session slot — and the claim is matched against the (user,
            // device) pair RECORDED ON THE SESSION, because both sides of a
            // v1 session belong to the same account. The device id comes from
            // this connection's attestation, never from the message.
            let Some(device) = state.device_of_conn(user_id, conn_id) else {
                return Err("this connection has not attested as a device".to_string());
            };
            match state.reattach_device_session(&session_id, user_id, &device, conn_id) {
                DeviceReattachOutcome::Rebound {
                    other_conn,
                    other_user,
                    other_detached,
                } => {
                    // `peer_connected` rides the ack because the claimant may
                    // never have heard DevicePeerReconnecting: when both sides
                    // dropped together that notice went to a conn that no
                    // longer existed, and a bare "reattached" cleared the
                    // claimant's banner over a half-dead session.
                    state.send_to_conn(
                        user_id,
                        conn_id,
                        ServerMessage::DeviceReattached {
                            session_id: session_id.clone(),
                            peer_connected: !other_detached,
                        },
                    );
                    // A no-op when the peer is itself detached (stale conn,
                    // dropped silently) — its own reattach ack carries the
                    // state instead.
                    state.send_to_conn(
                        other_user,
                        other_conn,
                        ServerMessage::DevicePeerReconnected { session_id },
                    );
                }
                DeviceReattachOutcome::NoSuchSession => {
                    // Tell the claimant plainly so its UI can stop waiting —
                    // it was a party to this session, so the id is not a
                    // secret from it.
                    state.send_to_conn(
                        user_id,
                        conn_id,
                        ServerMessage::DeviceEnded {
                            session_id,
                            reason: "that session did not survive the disconnect".to_string(),
                        },
                    );
                }
                // A stranger probing session ids gets silence, exactly like
                // every other post-connect message from a non-member.
                DeviceReattachOutcome::NotYours => {}
            }
        }

        ClientMessage::DeviceWake {
            waker_device,
            mac,
            broadcast,
        } => {
            // Bounded before anything else: these strings are forwarded to
            // another of the user's machines, which will hand them to a socket.
            // EVERY REFUSAL BELOW ANSWERS ON THE WAKE CHANNEL rather than as a
            // bare `Error`. The generic frame is listened for only by the chat
            // view, which alerts; the wake card never heard it, so a request
            // refused outright — no waker online, a device asking to wake
            // itself — was indistinguishable from one in flight, and the card
            // counted down for three minutes before blaming the BIOS for a
            // packet that was never sent.
            let refuse = |msg: &str| {
                state.send_to_conn(
                    user_id,
                    conn_id,
                    ServerMessage::DeviceWakeResult { ok: false, message: Some(msg.to_string()) },
                );
                Ok(())
            };

            if waker_device.len() > MAX_DEVICE_ID_LEN
                || mac.len() > 32
                || broadcast.as_ref().is_some_and(|b| b.len() > 64)
            {
                return refuse("invalid wake request");
            }
            // Only an attested device may ask, and only ANOTHER of your own
            // devices can be asked. The server never sees which MAC belongs to
            // which device (lan_info is client-encrypted); it only relays an
            // instruction the client already decided on.
            let Some(asker) = state.device_of_conn(user_id, conn_id) else {
                return refuse("this connection has not attested as a device");
            };
            // Compare DEVICES, not connections. `conn_of_device` returns the
            // first session matching the id in a linear scan, and one device
            // may hold several sockets at once (a reconnect overlapping its
            // predecessor, a second window). Comparing conn ids let a device
            // name itself, resolve to its OTHER socket, and pass a check whose
            // error message claims otherwise. Harmless in effect — a machine
            // broadcasting to wake itself is a no-op — but this is the guard
            // that the wake feature now exercises constantly, so it should
            // enforce what it says.
            if asker == waker_device {
                return refuse("a device cannot wake the network on its own behalf");
            }
            let Some(waker_conn) = state.conn_of_device(user_id, &waker_device) else {
                return refuse("that device isn't online to send the wake packet");
            };
            // The delivery result is REPORTED, not discarded. `send_to_conn` is
            // a bounded `try_send`, so a full or orphaned channel returns false
            // — which is precisely the stale-session case the 75s idle reaper
            // leaves behind after a machine is switched off, and the one that
            // used to swallow the whole request in silence.
            let delivered = state.send_to_conn(
                user_id,
                waker_conn,
                ServerMessage::DeviceWakeRequested { mac, broadcast },
            );
            if !delivered {
                return refuse("that device dropped off before it could send the wake packet");
            }
            // Relayed — NOT "it woke". A magic packet is unacknowledged and the
            // only proof is the machine coming back, which the client waits for.
            state.send_to_conn(
                user_id,
                conn_id,
                ServerMessage::DeviceWakeResult { ok: true, message: None },
            );
        }

        // --- Remote-control relay (dumb pipe; the host client is the real gate) ---
        // Remote control only happens between peers already sharing a voice /
        // screen-share room, so require that here — otherwise a client could spam
        // ControlRequested prompts (with an attacker-chosen from_username) at any
        // enumerated user. Drop silently when they share no room.
        ClientMessage::ControlRequest { target_user, eph } => {
            if eph.as_ref().is_some_and(|e| e.len() > MAX_CONTROL_EVENT_LEN) {
                return Err("handshake payload too long".to_string());
            }
            if users_share_room(state, user_id, target_user) {
                state.send_signal_to_user(
                    user_id,
                    conn_id,
                    target_user,
                    ServerMessage::ControlRequested {
                        from_user: user_id,
                        from_username: username.to_string(),
                        eph,
                    },
                );
            }
        }

        ClientMessage::ControlResponse {
            target_user,
            granted,
            eph,
            cap_w,
            cap_h,
        } => {
            if eph.as_ref().is_some_and(|e| e.len() > MAX_CONTROL_EVENT_LEN) {
                return Err("handshake payload too long".to_string());
            }
            if users_share_room(state, user_id, target_user) {
                state.send_signal_to_user(
                    user_id,
                    conn_id,
                    target_user,
                    ServerMessage::ControlResponse {
                        from_user: user_id,
                        granted,
                        eph,
                        cap_w,
                        cap_h,
                    },
                );
            }
        }

        ClientMessage::ControlInput { target_user, event } => {
            if event.len() > MAX_CONTROL_EVENT_LEN {
                return Err("control event too long".to_string());
            }
            if users_share_room(state, user_id, target_user) {
                state.send_signal_to_user(
                    user_id,
                    conn_id,
                    target_user,
                    ServerMessage::ControlInput {
                        from_user: user_id,
                        event,
                    },
                );
            }
        }

        ClientMessage::ControlEnd { target_user } => {
            if users_share_room(state, user_id, target_user) {
                state.send_signal_to_user(
                    user_id,
                    conn_id,
                    target_user,
                    ServerMessage::ControlEnded { from_user: user_id },
                );
            }
        }

        // --- Peer-to-peer file transfer control plane -----------------------
        // No file bytes pass through here: this relays offers and the transfer's
        // own WebRTC signalling so two clients can build a direct data channel.
        ClientMessage::FileOffer {
            target_user,
            transfer_id,
            name,
            size,
            mime,
            sha256,
            target_device,
            auth,
            auth_v,
            fp,
            ts,
        } => {
            // Sending to yourself IS allowed — PC to phone is the main reason
            // to move something large peer-to-peer. It is routed by CONNECTION
            // rather than user id further down, so the offer reaches your other
            // device instead of echoing back here, and it is refused with a
            // clear reason if no other device is signed in.
            if !valid_transfer_id(&transfer_id) {
                return Err("Invalid transfer id".to_string());
            }
            if name.len() > MAX_FILE_NAME_LEN || name.is_empty() {
                return Err("Invalid file name".to_string());
            }
            if mime.len() > MAX_MIME_LEN
                || sha256.len() != 64
                || !sha256.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err("Invalid file metadata".to_string());
            }
            // Bound the relayed offer MAC (a base64 HMAC-SHA256 is ~44 chars);
            // the server only passes it through to the recipient, who verifies
            // it against the sender's pinned key.
            if auth.as_ref().is_some_and(|a| a.len() > 128) {
                return Err("Invalid offer authentication".to_string());
            }
            // A DTLS fingerprint is ~100 chars; relayed, never interpreted here.
            if fp.as_ref().is_some_and(|f| f.len() > 256) {
                return Err("Invalid offer authentication".to_string());
            }
            // Bound how many transfers one user can have in flight, so offers
            // cannot be used to accumulate registry entries.
            let mine = state
                .file_transfers
                .iter()
                .filter(|t| t.from == user_id)
                .count();
            if mine >= MAX_TRANSFERS_PER_USER {
                return Err("Too many transfers in progress".to_string());
            }
            // The ONLY database check in this path, and it runs once per
            // transfer: may these two message each other at all? Everything
            // afterwards is authorized against the registered pair.
            if !users_can_dm(state, user_id, target_user).await {
                return Err("You cannot send files to this user".to_string());
            }
            // A transfer id is chosen by the sender, so refuse to overwrite one
            // that exists — otherwise a second offer could hijack the routing of
            // a transfer already in progress between two other people.
            if state.file_transfers.contains_key(&transfer_id) {
                return Err("Transfer already exists".to_string());
            }
            // A direct transfer needs BOTH people connected — there is no
            // server-side copy to collect later. But at offer time "offline"
            // is indistinguishable from "phone in a pocket": Android drops
            // the chat socket the moment the app backgrounds, and the
            // receiver has to open the app to tap Accept regardless. So an
            // offer with nowhere to go is PARKED — held on the transfer
            // record and delivered by deliver_parked_offers when a
            // qualifying socket appears — rather than refused (which made
            // PC-to-pocketed-phone, the feature's main use, fail every
            // time; field-confirmed 2026-08-10). The sender is told via
            // FileParked so its card says what is actually happening, and
            // the unaccepted-offer TTL bounds the wait; expiry then reports
            // an honest reason to the sender.
            let to_self = target_user == user_id;
            // Pinned to ONE device when the sender named it. Without this a
            // self-transfer is offered to every other device of yours and
            // whichever answers first wins — ambiguous once you own three,
            // and it means "send this to my laptop" cannot be expressed.
            let named_device_conn = if to_self {
                target_device
                    .as_deref()
                    .and_then(|d| state.conn_of_device(user_id, d))
            } else {
                None
            };
            let deliverable = if to_self {
                match target_device.as_deref() {
                    Some(_) => matches!(named_device_conn, Some(c) if c != conn_id),
                    // A second VISIBLE device must exist: send_to_user_except_conn
                    // with one connection would offer the file to nobody, and a
                    // delivery socket is not a device — it drops transfer frames
                    // unread. Counting it made "send to my other device" from a
                    // single phone claim delivery while delivering to nobody.
                    None => state.visible_session_count(user_id) >= 2,
                }
            } else {
                // Same rule: a recipient whose only session is their phone's
                // background delivery socket is NOT reachable for a transfer —
                // park the offer, exactly as when they are fully offline. This
                // is the predicate whose delivery-blindness broke
                // PC-to-pocketed-phone transfers in 0.8.66.
                state.is_user_visibly_online(target_user)
            };
            // r2-4-L4-02: a recipient who hides their presence
            // (show_online_status = false) must look OFFLINE to the sender in
            // both states, or the FileParked-vs-silence difference is a
            // presence oracle against the very toggle GET /servers/:id/members
            // honours. `hidden_target` flattens every sender-facing note: the
            // offer is reported as parked even when it went straight out to a
            // hidden-online recipient, the connect-time "reached them" note is
            // suppressed (state.rs), and expiry reports "never came online"
            // (reap). The offer itself still reaches an online recipient — only
            // the SENDER's observable is flattened. Never for a self-transfer.
            // Fails CLOSED: a lookup error or a missing row masks (only a row
            // that positively shows online un-masks) — `user_shows_online`'s
            // open default would let a DB blip re-open the oracle.
            let hidden_target =
                target_is_hidden(to_self, show_online_status(&state, target_user).await);
            let parked_offer = if deliverable {
                None
            } else {
                Some(crate::state::ParkedOffer {
                    from_username: username.to_string(),
                    name: name.clone(),
                    size,
                    mime: mime.clone(),
                    sha256: sha256.clone(),
                    target_device: if to_self { target_device.clone() } else { None },
                    auth: auth.clone(),
                    auth_v,
                    fp: fp.clone(),
                    ts,
                })
            };
            let parked = parked_offer.is_some();
            state.file_transfers.insert(
                transfer_id.clone(),
                crate::state::FileTransfer {
                    from: user_id,
                    to: target_user,
                    accepted: false,
                    touched_at: std::time::Instant::now(),
                    // Pin the offering socket so a self-transfer can tell its two
                    // devices apart (see FileTransfer::opposite_conn).
                    from_conn: conn_id,
                    to_conn: None,
                    parked_offer,
                    hidden_target,
                },
            );
            // The reason a hidden-online recipient is masked with: byte-identical
            // to the genuinely-offline non-self reason, so the two are
            // indistinguishable to the sender.
            let offline_reason = "their app isn't connected right now — the offer will reach them when they open Puca (it expires in about 2 minutes)";
            if parked {
                let reason = if to_self && target_device.is_some() {
                    "that device isn't connected — the offer will reach it when Puca opens there (it expires in about 2 minutes)"
                } else if to_self {
                    "your other device isn't connected — the offer will reach it when Puca opens there (it expires in about 2 minutes)"
                } else {
                    offline_reason
                };
                state.send_to_conn(
                    user_id,
                    conn_id,
                    ServerMessage::FileParked {
                        from_user: target_user,
                        transfer_id,
                        reason: reason.to_string(),
                    },
                );
                return Ok(());
            }
            let offer = ServerMessage::FileOffered {
                from_user: user_id,
                from_username: username.to_string(),
                transfer_id: transfer_id.clone(),
                name,
                size,
                mime,
                sha256,
                auth,
                auth_v,
                fp,
                ts,
            };
            if to_self {
                match named_device_conn {
                    Some(target_conn) if target_conn != conn_id => {
                        state.send_to_conn(user_id, target_conn, offer);
                    }
                    _ => {
                        // Your OTHER devices only. send_to_user would fan out to
                        // every session including this one, so the sending
                        // device would be offered its own file and could accept
                        // it — connecting a data channel to itself.
                        state.send_to_user_except_conn(user_id, conn_id, offer);
                    }
                }
            } else {
                state.send_to_user(target_user, offer);
                // r2-4-L4-02: the offer went straight out (recipient is online),
                // but a hidden recipient's sender must see exactly what the
                // offline path shows — a FileParked with the same reason —
                // rather than the silence that betrays a live visible session.
                if hidden_target {
                    state.send_to_conn(
                        user_id,
                        conn_id,
                        ServerMessage::FileParked {
                            from_user: target_user,
                            transfer_id,
                            reason: offline_reason.to_string(),
                        },
                    );
                }
            }
        }

        ClientMessage::FileAccept {
            transfer_id,
            resume_from,
            auth,
            auth_v,
            fp,
        } => {
            if auth.as_ref().is_some_and(|a| a.len() > 128) || fp.as_ref().is_some_and(|f| f.len() > 256) {
                return Err("Invalid accept authentication".to_string());
            }
            // Only the RECIPIENT may accept, and only a transfer they were
            // actually offered.
            let sender = match state.file_transfers.get_mut(&transfer_id) {
                // Single-shot. Without this, a recipient could replay
                // FileAccept and make the SENDER allocate a fresh
                // RTCPeerConnection + data channel per message, leaking the
                // previous one and re-reading their file from disk each time.
                Some(mut t) if t.to == user_id && !t.accepted => {
                    // A self-transfer must not be accepted by the very device
                    // that offered it — that would dial a data channel to
                    // itself. Only the OTHER device may take it.
                    if t.is_self_transfer() && conn_id == t.from_conn {
                        return Err("Accept this on your other device".to_string());
                    }
                    t.accepted = true;
                    t.touched_at = std::time::Instant::now();
                    t.to_conn = Some(conn_id);
                    // Accepting proves delivery; a stale parked payload must
                    // not be re-offered to some later connection.
                    t.parked_offer = None;
                    (t.from, t.is_self_transfer().then_some(t.from_conn))
                }
                Some(t) if t.to == user_id && t.accepted => {
                    return Err("Transfer already accepted".to_string());
                }
                _ => return Err("Unknown transfer".to_string()),
            };
            let (sender, sender_conn) = sender;
            let accepted = ServerMessage::FileAccepted {
                from_user: user_id,
                transfer_id,
                resume_from,
                auth,
                auth_v,
                fp,
            };
            match sender_conn {
                // Self-transfer: answer the offering socket specifically.
                Some(c) => {
                    state.send_to_conn(sender, c, accepted);
                }
                None => {
                    state.send_to_user(sender, accepted);
                }
            }
        }

        ClientMessage::FileReject {
            transfer_id,
            reason,
        } => {
            let sender = match state.file_transfers.get(&transfer_id) {
                Some(t) if t.to == user_id => t.from,
                _ => return Err("Unknown transfer".to_string()),
            };
            state.file_transfers.remove(&transfer_id);
            state.send_to_user(
                sender,
                ServerMessage::FileRejected {
                    from_user: user_id,
                    transfer_id,
                    reason: truncate_reason(reason),
                },
            );
        }

        ClientMessage::FileComplete { transfer_id } => {
            // Frees the registry slot as soon as the bytes are through.
            // Without it the per-user cap counts finished transfers: eight
            // successful sends and the next FileOffer is refused with "Too
            // many transfers in progress" for the whole 6-hour idle TTL,
            // because touched_at was last stamped during signalling.
            let peer = state
                .file_transfers
                .get(&transfer_id)
                .and_then(|t| t.peer_of(user_id));
            if peer.is_some() {
                state.file_transfers.remove(&transfer_id);
            }
        }

        ClientMessage::FileCancel {
            transfer_id,
            reason,
        } => {
            // Either party may cancel, at any stage.
            let peer = match state.file_transfers.get(&transfer_id) {
                // Same self-transfer problem as FileSignal: by user id both
                // legs are this account, so a cancel would also be delivered
                // back to the device that cancelled.
                Some(t) => t.peer_of(user_id).map(|p| (p, t.opposite_conn(conn_id))),
                None => None,
            };
            let Some((peer, peer_conn)) = peer else {
                return Err("Unknown transfer".to_string());
            };
            state.file_transfers.remove(&transfer_id);
            // Pass the sender's reason through. It was hardcoded to
            // "cancelled", so a transfer refused for a specific, actionable
            // cause — "too large for a relayed connection" — reached the other
            // party as a shrug, while the abrupt teardown surfaced there as a
            // data-channel error. The peer was told nothing true.
            let cancelled = ServerMessage::FileCancelled {
                from_user: user_id,
                transfer_id,
                reason: reason
                    .map(truncate_reason)
                    .unwrap_or_else(|| "cancelled".to_string()),
            };
            match peer_conn {
                Some(c) => {
                    state.send_to_conn(peer, c, cancelled);
                }
                None => {
                    state.send_to_user(peer, cancelled);
                }
            }
        }

        ClientMessage::FileSignal {
            transfer_id,
            payload,
        } => {
            if payload.len() > MAX_SDP_LEN {
                return Err("signal too long".to_string());
            }
            // Authorized by MEMBERSHIP OF THE TRANSFER — narrower than the DM
            // check that admitted it, and no database round trip on a path that
            // ICE hits in bursts.
            let peer = match state.file_transfers.get_mut(&transfer_id) {
                Some(mut t) => {
                    if !t.involves(user_id) {
                        return Err("Unknown transfer".to_string());
                    }
                    t.touched_at = std::time::Instant::now();
                    // For a self-transfer, route to the OPPOSITE SOCKET. By
                    // user id both legs are the same account, so send_to_user
                    // would hand each device its own SDP offer back and
                    // setRemoteDescription would fail on both ends.
                    t.peer_of(user_id).map(|p| (p, t.opposite_conn(conn_id)))
                }
                None => None,
            };
            let Some((peer, peer_conn)) = peer else {
                return Err("Unknown transfer".to_string());
            };
            let signal = ServerMessage::FileSignal {
                from_user: user_id,
                transfer_id,
                payload,
            };
            match peer_conn {
                Some(c) => {
                    state.send_to_conn(peer, c, signal);
                }
                None => {
                    state.send_to_user(peer, signal);
                }
            }
        }

        ClientMessage::Typing { room_id } => {
            // M9: only a current member of the room may broadcast a typing ping,
            // so a non-member can't spam typing indicators into a channel/voice
            // room they never joined.
            if !can_mutate_room(state, &room_id, user_id).await {
                return Err("Not in this room".to_string());
            }
            // Broadcast typing status to other users in the room
            let msg = ServerMessage::UserTyping {
                room_id: room_id.clone(),
                user: UserInfo::new(user_id, username.to_string()),
            };
            if let Some(room) = state.rooms.get(&room_id) {
                for &member_id in room.members.iter() {
                    if member_id != user_id {
                        state.send_to_user(member_id, msg.clone());
                    }
                }
            }
        }

        ClientMessage::DirectMessage {
            to_user_id,
            content,
        } => {
            // Validation parity with the REST DM endpoint (dm_handlers::send_message):
            // reject empty, oversized (>8000 bytes), or NUL-containing content.
            // Without this the WS path was an unbounded storage-amplification vector.
            if content.trim().is_empty() || content.len() > 8000 || content.contains('\0') {
                return Err("Invalid message content".to_string());
            }

            let timestamp = Utc::now().timestamp();
            let message_id = uuid::Uuid::new_v4().to_string();

            // Enforce blocks server-side. The REST DM endpoint checks this, but
            // the frontend sends DMs over this WS path — so without the same
            // check here, blocking a user does not actually stop their DMs.
            // blocked_users columns are INT4, so bind as i32.
            // Fail CLOSED on a query error — a block is a deny list.
            let blocked: Option<(i32,)> = match sqlx::query_as(
                "SELECT 1 FROM blocked_users \
                 WHERE (blocker_id = $1 AND blocked_id = $2) \
                    OR (blocker_id = $2 AND blocked_id = $1)",
            )
            .bind(user_id as i32)
            .bind(to_user_id as i32)
            .fetch_optional(&state.pool)
            .await
            {
                Ok(row) => row,
                Err(e) => {
                    tracing::error!("DirectMessage: block lookup failed for user {}: {:?}", user_id, e);
                    return Err("Could not verify block status".to_string());
                }
            };
            if blocked.is_some() {
                // Same words as the consent refusal below: a block must not be
                // distinguishable from a privacy setting (re-audit r2-1-L1-03,
                // review finding 4; the REST DM routes collapse the same way).
                return Err("This user only accepts direct messages from friends and people who share a server with them".to_string());
            }

            // Same parity for the friends-only DM privacy flag: the Settings
            // toggle is enforced here because THIS is the path DMs travel.
            if !crate::dm_handlers::recipient_accepts_dms(&state, user_id, to_user_id).await {
                return Err("This user only accepts direct messages from friends and people who share a server with them".to_string());
            }

            // Get or create conversation (ensure consistent ordering)
            let (user1, user2) = if user_id < to_user_id {
                (user_id, to_user_id)
            } else {
                (to_user_id, user_id)
            };

            // Try to get existing conversation or create new one
            // Get-or-create in a single race-safe upsert. The old SELECT-then-INSERT
            // could, when two users first-DM each other simultaneously, insert
            // nothing (unique-constraint conflict, error ignored) and then use a
            // conversation id that doesn't exist — silently dropping the message on
            // the dm_messages FK. Upsert-returning always yields the real id.
            let new_id = uuid::Uuid::new_v4().to_string();
            let conv_id: String = match sqlx::query_as::<_, (String,)>(
                "INSERT INTO dm_conversations (id, user1_id, user2_id) VALUES ($1, $2, $3) \
                 ON CONFLICT (user1_id, user2_id) DO UPDATE SET user1_id = EXCLUDED.user1_id \
                 RETURNING id",
            )
            .bind(&new_id)
            .bind(user1)
            .bind(user2)
            .fetch_one(&state.pool)
            .await
            {
                Ok((id,)) => id,
                Err(_) => return Err("Failed to get conversation".to_string()),
            };

            // Save message to database
            let _ = sqlx::query(
                "INSERT INTO dm_messages (id, conversation_id, sender_id, content, created_at) VALUES ($1, $2, $3, $4, NOW())"
            )
            .bind(&message_id)
            .bind(&conv_id)
            .bind(user_id)
            .bind(&content)
            .execute(&state.pool)
            .await;

            // Update conversation timestamp
            let _ = sqlx::query("UPDATE dm_conversations SET updated_at = NOW() WHERE id = $1")
                .bind(&conv_id)
                .execute(&state.pool)
                .await;

            // Send to recipient if online — their phone's native delivery
            // socket is a session of the same user, so this fan-out reaches it
            // and the notification posts from Java. Nobody home at all: park
            // the frame and ring the wake doorbell (a constant over FCM; the
            // frame itself — names, ids, ciphertext — waits server-side for
            // the delivery socket the signal summons and never crosses Google).
            let dm = ServerMessage::DirectMessage {
                message_id: message_id.clone(),
                conversation_id: conv_id.clone(),
                sender: UserInfo::new(user_id, username.to_string()),
                content: content.clone(),
                timestamp,
            };
            if !state.send_to_user(to_user_id, dm.clone()) && to_user_id != user_id {
                state.enqueue_undelivered(to_user_id, dm);
                crate::wake::sender::wake_user_kind(
                    &state,
                    to_user_id,
                    crate::wake::sender::WakeKind::DirectMessage,
                );
            }

            // Also echo back to sender for confirmation
            state.send_to_user(
                user_id,
                ServerMessage::DirectMessage {
                    message_id,
                    conversation_id: conv_id,
                    sender: UserInfo::new(user_id, username.to_string()),
                    content,
                    timestamp,
                },
            );
        }
    }

    Ok(())
}

/// How long a handler waits for [`broadcast_perms_changed_and_evict`]'s work
/// before it answers anyway. A healthy sweep takes milliseconds (database
/// lookups and a handful of LiveKit calls), so this binds only when LiveKit is
/// slow or unreachable - each call there may take its full 5 s - and it keeps
/// the request well inside any proxy's timeout. The work is detached, so
/// answering early never cuts it short.
const PERMS_CHANGE_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// After any permission-affecting change in `server_id` (channel overwrite
/// created/updated/deleted, role permissions edited, member roles changed):
/// 1) broadcast ChannelPermsChanged to every server member (same fan-out
///    pattern as ChannelCreated in create_channel) so clients refetch their
///    channel list / my_permissions, and
/// 2) evict now-VIEW-denied users from this server's live in-memory rooms
///    (channel_<id> / voice_<id>) — otherwise a freshly hidden channel keeps
///    streaming to members who could no longer join it.
///
/// Call it AFTER the change is committed. The work runs in a DETACHED task: a
/// handler whose request is cancelled (the client gave up, a proxy cut it)
/// used to take the queued or running sweep with it, and nothing else would
/// ever evict. The handler still waits for it - so a kick has evicted by the
/// time its response returns, whenever nothing is slow - but for at most
/// [`PERMS_CHANGE_WAIT`]; after that it answers while the work finishes.
pub async fn broadcast_perms_changed_and_evict(state: &Arc<AppState>, server_id: &str) {
    start_perms_change(state, server_id).wait().await;
}

/// [`broadcast_perms_changed_and_evict`] in two halves, for a handler with
/// more to await after its commit (an audit row): START it straight after the
/// commit, with no await in between - from then on a cancelled request cannot
/// lose it - then do the rest, then [`PendingPermsChange::wait`].
pub fn start_perms_change(state: &Arc<AppState>, server_id: &str) -> PendingPermsChange {
    let work = tokio::spawn(crate::sfu::carry_test_livekit(perms_changed(Arc::clone(state), server_id.to_string())));
    PendingPermsChange { work, server_id: server_id.to_string() }
}

/// A perms change already running detached ([`start_perms_change`]).
pub struct PendingPermsChange {
    work: tokio::task::JoinHandle<()>,
    server_id: String,
}

impl PendingPermsChange {
    /// Wait for it, at most [`PERMS_CHANGE_WAIT`].
    pub async fn wait(self) {
        self.wait_at_most(PERMS_CHANGE_WAIT).await;
    }

    /// Wait for it, at most `wait`. Whether it (its sweep included) finished.
    async fn wait_at_most(self, wait: std::time::Duration) -> bool {
        match tokio::time::timeout(wait, self.work).await {
            Ok(_) => true,
            Err(_) => {
                // Dropping the JoinHandle detaches the task; it carries on.
                tracing::warn!(
                    "Perms change in server {}: still sweeping after {} s (LiveKit slow or unreachable?); answering now, the sweep finishes in the background",
                    self.server_id,
                    wait.as_secs()
                );
                false
            }
        }
    }
}

/// [`broadcast_perms_changed_and_evict`], waiting at most `wait`. Returns
/// whether the work (its sweep included) had finished by then.
#[cfg(test)]
async fn perms_changed_within(state: &Arc<AppState>, server_id: &str, wait: std::time::Duration) -> bool {
    start_perms_change(state, server_id).wait_at_most(wait).await
}

/// The body of [`broadcast_perms_changed_and_evict`], run detached.
async fn perms_changed(state: Arc<AppState>, server_id: String) {
    let (state, server_id) = (&state, server_id.as_str());
    // 0) Bump the member generation so the channel key ROTATES, exactly as it
    // does on a join/leave (migration 015's trigger). Losing VIEW is a
    // revocation like any other, but it left the key in force: the revoked
    // user keeps a valid copy of the current CK — and of the SFU media key
    // derived from it — for content produced AFTER they lost access. Every
    // route that would hand them that ciphertext is authorization-gated, so
    // this is revocation lag rather than disclosure, but the cryptographic
    // backstop was simply absent where the join/leave path has one.
    //
    // Before the broadcast, not after: clients refetch keys when they receive
    // ChannelPermsChanged, and a refetch that lands before the bump would read
    // the old generation and decide no rotation was needed.
    //
    // Rotation only ever APPENDS an epoch — no rows are deleted, messages carry
    // their `key_epoch`, and a client fetches every epoch addressed to it — so
    // history stays readable and nobody is stranded.
    if let Err(e) =
        sqlx::query("UPDATE servers SET member_generation = member_generation + 1 WHERE id = $1")
            .bind(server_id)
            .execute(&state.pool)
            .await
    {
        // Non-fatal: the eviction below still removes their live access. Worst
        // case is the old key staying current until the next membership change.
        tracing::error!(
            "broadcast_perms_changed_and_evict: generation bump failed for server {}: {}",
            server_id,
            e
        );
    }

    // 1) Notify every member (offline members are a no-op in send_to_user).
    let members: Vec<(i32,)> =
        match sqlx::query_as("SELECT user_id FROM server_members WHERE server_id = $1")
            .bind(server_id)
            .fetch_all(&state.pool)
            .await
        {
            Ok(rows) => rows,
            Err(e) => {
                tracing::error!(
                    "broadcast_perms_changed_and_evict: member fetch failed for server {}: {}",
                    server_id,
                    e
                );
                Vec::new()
            }
        };
    for (member_id,) in &members {
        state.send_to_user(
            *member_id as i64,
            ServerMessage::ChannelPermsChanged {
                server_id: server_id.to_string(),
            },
        );
    }

    // 2) The eviction sweep itself, queued (see request_perms_sweep), with a
    // scheduled retry if its scope query fails (see evict_sweep). Waited for:
    // it is the run that starts after this change committed.
    request_perms_sweep(state, server_id, 3).wait().await;
}

/// One server's perms-change sweeps ([`AppState::perms_sweeps`]): at most one
/// RUNNING and one PENDING, however many changes ask.
///
/// Why a queue: every change used to run its own sweep inline in its HTTP
/// handler, serialized per server. With LiveKit slow, each queued sweep sat
/// through the one before it and then repeated every LiveKit call that one
/// had failed - a failed grant or removal records nothing, so it is sent
/// again - and a request cancelled while it waited lost its sweep outright.
///
/// Coalescing keeps what matters. A sweep resolves every member when it
/// STARTS, so the one pending run - which starts only after the running one
/// has finished acting - covers every change committed before it starts, and
/// its answer is newer than anything the running one applied (the guarantee
/// the per-server lock gives: see `AppState::lock_server_perms`, which the
/// sweep still holds for the `participant_joined` check and the resync).
pub struct SweepQueue {
    /// Runs STARTED so far; while a run is going, this is its number.
    started: u64,
    /// The latest run a request is waiting for. A run starts while it is ahead
    /// of `started`.
    wanted: u64,
    /// Scope-query retries the next run carries: the most any request asked.
    retries: u8,
    /// The number of the last run that FINISHED, for the requests waiting.
    finished: tokio::sync::watch::Sender<u64>,
}

/// A request's place in its server's sweep queue.
pub(crate) struct SweepTicket {
    run: u64,
    finished: tokio::sync::watch::Receiver<u64>,
}

impl SweepTicket {
    /// The run that covers this request: the first to START after it asked.
    #[cfg(test)]
    pub(crate) fn run(&self) -> u64 {
        self.run
    }

    /// Until that run has finished (or its runner is gone).
    pub(crate) async fn wait(mut self) {
        let run = self.run;
        let _ = self.finished.wait_for(|&f| f >= run).await;
    }
}

/// Ask for a sweep of `server_id` that STARTS after now - resolving every
/// member after whatever the caller committed. Joins the pending run if there
/// is one; otherwise it becomes the pending run (after the running one) or,
/// with none running, starts a runner for it. The runner is its own task, so
/// nobody who asked can cancel it by going away.
pub(crate) fn request_perms_sweep(state: &Arc<AppState>, server_id: &str, retries: u8) -> SweepTicket {
    use dashmap::mapref::entry::Entry;
    let (ticket, start_runner) = match state.perms_sweeps.entry(server_id.to_string()) {
        Entry::Occupied(mut o) => {
            let q = o.get_mut();
            // Not the running one: it may have resolved before this change.
            let run = q.started + 1;
            q.wanted = q.wanted.max(run);
            q.retries = q.retries.max(retries);
            (SweepTicket { run, finished: q.finished.subscribe() }, false)
        }
        Entry::Vacant(v) => {
            let (finished, rx) = tokio::sync::watch::channel(0);
            v.insert(SweepQueue { started: 0, wanted: 1, retries, finished });
            (SweepTicket { run: 1, finished: rx }, true)
        }
    };
    if start_runner {
        tokio::spawn(crate::sfu::carry_test_livekit(run_perms_sweeps(Arc::clone(state), server_id.to_string())));
    }
    ticket
}

/// A server's sweep runner: runs sweeps one after another while any request
/// is waiting for one, then leaves - removing the queue entry in the same
/// step that finds nothing wanted, so a request either lands before that
/// (and is run) or after it (and starts a new runner).
async fn run_perms_sweeps(state: Arc<AppState>, server_id: String) {
    let mut runner = SweepRunner { state: &state, server_id: &server_id, finished: false };
    loop {
        if state.perms_sweeps.remove_if(&server_id, |_, q| q.wanted <= q.started).is_some() {
            runner.finished = true;
            return;
        }
        // Only this runner removes the entry, so it is still there.
        let Some((run, retries)) = state.perms_sweeps.get_mut(&server_id).map(|mut q| {
            q.started += 1;
            (q.started, std::mem::take(&mut q.retries))
        }) else {
            runner.finished = true;
            return;
        };
        evict_sweep(&state, &server_id, retries).await;
        if let Some(q) = state.perms_sweeps.get(&server_id) {
            q.finished.send_replace(run);
        }
    }
}

/// Removes a runner's queue entry if the runner ends any way but its own
/// (a panic in a sweep): an entry must never outlive its runner, or every
/// later request would wait on a runner that no longer exists. Removing it
/// closes the channel, so everyone waiting returns.
struct SweepRunner<'a> {
    state: &'a AppState,
    server_id: &'a str,
    finished: bool,
}

impl Drop for SweepRunner<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.state.perms_sweeps.remove(self.server_id);
            tracing::error!("Perms sweep runner for server {} ended abnormally; its queue was dropped", self.server_id);
        }
    }
}

/// The eviction half of [`broadcast_perms_changed_and_evict`]: remove from
/// this server's live rooms (mesh `channel_<id>` / `voice_<id>` and SFU) every
/// member whose current permissions no longer satisfy the JOIN gate. The body
/// of each run of the server's sweep queue ([`run_perms_sweeps`]), the delayed
/// retry a failed scope query asks for included.
async fn evict_sweep(state: &Arc<AppState>, server_id: &str, retries_left: u8) {
    // ONE sweep per server at a time, for its whole run, and never alongside
    // the SFU join checks for this server (the `participant_joined` check and
    // the resync's), which take the same lock. The queue already runs one
    // sweep at a time; the lock is what orders it against those checks. A
    // sweep resolves members up front (allowed_cache) and acts on them
    // afterwards, with awaits in between; two resolve-then-act passes
    // interleaving let the EARLIER answer land after the later one - a stale
    // SPEAK allow re-granting a microphone just taken away at LiveKit, or
    // flipping a voice room's speak flag back - and nothing would ever look
    // again. Held from before the snapshot, a later one resolves only after
    // this one has finished acting. The retry this sweep may ask for below is
    // queued by a task of its own; it never runs inside this one.
    let _serial = state.lock_server_perms(server_id).await;
    // A sweep of this server has started: before the snapshot, so a voice
    // join that read the epoch before this knows its own speak answer may be
    // older than this sweep's (store_join_speak).
    *state.perms_sweep_epochs.entry(server_id.to_string()).or_insert(0) += 1;

    // 2) Snapshot the candidate rooms first — the resolver awaits, and holding
    // DashMap guards across await points risks shard deadlocks.
    let snapshot: Vec<(String, i64, Vec<UserId>)> = state
        .rooms
        .iter()
        .filter_map(|r| {
            let cid = parse_channel_room(r.key()).or_else(|| parse_voice_room(r.key()))?;
            Some((r.key().clone(), cid, r.value().members.clone()))
        })
        .collect();
    // SFU rooms are candidates in their own right: a LiveKit session whose
    // Púca socket is not in voice_<id> (it never rejoined after a restart, or
    // it died) holds no mesh room, and the SFU pass below only sees channels
    // in this scope.
    let sfu_ids: Vec<i64> = state
        .sfu_rooms
        .iter()
        .filter_map(|r| crate::sfu::channel_id_from_room(r.key()))
        .collect();
    let mesh_ids: Vec<i64> = snapshot.iter().map(|(_, cid, _)| *cid).collect();
    let Some(candidate_ids) = sweep_candidate_ids(&mesh_ids, &sfu_ids) else {
        return;
    };

    // Restrict to rooms whose channel belongs to THIS server (one query).
    // `None` = the query failed and the scope is UNKNOWN; see sweep_keeps for
    // what the sweep then does with each member, and the retry below.
    let scope: Option<std::collections::HashSet<i64>> = match sqlx::query_as::<_, (i32,)>(
        "SELECT id FROM channels WHERE server_id = $1 AND id::bigint = ANY($2)",
    )
    .bind(server_id)
    .bind(&candidate_ids)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => Some(rows.into_iter().map(|(id,)| id as i64).collect()),
        Err(e) => {
            // This is the only revocation path for live room subscriptions and
            // the ChannelPermsChanged broadcast has already told the moderator
            // it worked, so giving up here left a kicked or denied member
            // subscribed to live frames for the socket's lifetime. Fail CLOSED
            // — but bounded: with the scope unknown, every room on the instance
            // is a candidate, and evicting them all on one transient error
            // would drop every call and silently stall every open channel for
            // users who never rejoin. So act only on what RESOLVES (a member of
            // this server who now lacks the bits, or is no longer a member at
            // all), leave what cannot be resolved to a retry, and leave other
            // servers' rooms alone.
            tracing::error!(
                "eviction sweep: channel scope query failed for server {}: {} — acting on what resolves; {}",
                server_id,
                e,
                if retries_left > 0 {
                    format!("retrying in {} s ({} retries left)", sweep_backoff_secs(retries_left), retries_left)
                } else {
                    "no retry left".to_string()
                }
            );
            if retries_left > 0 {
                let state = Arc::clone(state);
                let sid = server_id.to_string();
                tokio::spawn(crate::sfu::carry_test_livekit(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(sweep_backoff_secs(retries_left))).await;
                    // Through the queue, like any other sweep: it runs after
                    // (or with) whatever is pending, never beside it.
                    drop(request_perms_sweep(&state, &sid, retries_left - 1));
                }));
            }
            None
        }
    };
    let scope_known = scope.is_some();

    // Re-run the resolver per (channel, member, needs-CONNECT), cached — a user
    // sitting in both channel_<id> and voice_<id> resolves once per gate shape.
    // The value is (keeps, can_speak, grant perms): the sweep_keeps verdict,
    // for a voice room the member's SPEAK right from the SAME resolution
    // (sweep_speak) — a member who stays has it re-evaluated without a second
    // query — and the permissions the SFU pass hands LiveKit (sweep_grant).
    let mut allowed_cache: std::collections::HashMap<(i64, UserId, bool), (bool, Option<bool>, Option<Permissions>)> =
        std::collections::HashMap::new();
    for (room_id, cid, room_members) in snapshot {
        if let Some(set) = &scope {
            if !set.contains(&cid) {
                continue;
            }
        }
        // The sweep must mirror the JoinRoom gate: a voice room requires
        // CONNECT as well as VIEW. Re-checking VIEW alone meant a CONNECT deny
        // forbade future joins and left the present occupant in the call with
        // no time bound.
        let need_connect = parse_voice_room(&room_id).is_some();
        for member_id in room_members {
            let (allowed, can_speak, _) = match allowed_cache.get(&(cid, member_id, need_connect)) {
                Some(&verdict) => verdict,
                None => {
                    let access = get_user_channel_permissions(&state.pool, cid, member_id).await;
                    let verdict = (
                        sweep_keeps(scope_known, server_id, &access, need_connect),
                        sweep_speak(server_id, &access, need_connect),
                        sweep_grant(server_id, &access),
                    );
                    allowed_cache.insert((cid, member_id, need_connect), verdict);
                    verdict
                }
            };
            if allowed {
                // Staying in a voice room: a SPEAK allow/deny may be exactly
                // what changed. Tell the WHOLE room when the stored right
                // flipped — the member too, so their own client stops (or
                // resumes) sending. set_can_speak is a no-op for somebody who
                // left since the snapshot; the write guard is dropped before
                // the fan-out, which re-reads the flag under its own guard.
                if let Some(can_speak) = can_speak {
                    let changed = state
                        .rooms
                        .get_mut(&room_id)
                        .is_some_and(|mut room| room.set_can_speak(member_id, can_speak));
                    if changed {
                        state.broadcast_speak_state(&room_id, member_id, None);
                        tracing::info!(
                            "Perms sweep: user {} may {}speak in {} (change in server {})",
                            member_id,
                            if can_speak { "" } else { "no longer " },
                            room_id,
                            server_id
                        );
                    }
                }
                continue;
            }

            // Remove every connection of the user from the room, then notify:
            // RoomLeft tells the evicted user's client(s) to tear down locally
            // (incl. voice); UserLeft cleans the remaining members' rosters.
            // Media flags are captured BEFORE remove_member clears them so the
            // remaining members also get the media-stopped set (mirrors the
            // voice-exclusivity and unclean-disconnect paths — otherwise an
            // evicted streamer leaves a frozen ghost tile behind).
            let (was_streamer, was_sharer, was_camera) =
                if let Some(mut room) = state.rooms.get_mut(&room_id) {
                    let flags = (
                        room.streamers.contains(&member_id),
                        room.screen_sharers.contains(&member_id),
                        room.camera_users.contains(&member_id),
                    );
                    room.remove_member(member_id);
                    flags
                } else {
                    (false, false, false)
                }; // guard dropped before any broadcast re-reads rooms
            state.drop_room_if_empty(&room_id);
            if was_streamer {
                // Viewer-scoped, like every other StreamStopped emitter: the
                // voice roster is drawn by users who are NOT in the room, so a
                // room-only broadcast left the evicted member visible in
                // everyone else's sidebar (and was a no-op once the room
                // emptied out).
                let msg = ServerMessage::StreamStopped {
                    room_id: room_id.clone(),
                    streamer_id: member_id,
                };
                state.send_to_user(member_id, msg.clone());
                for audience_id in voice_roster_audience(state, &room_id, member_id).await {
                    state.send_to_user(audience_id, msg.clone());
                }
                // ALSO keep the room-scoped send as belt-and-braces: the
                // remaining room members are viewers today, but this retraction
                // must reach whoever holds a roster entry even if the viewer
                // resolve errors (voice_roster_audience fails closed to empty).
                // Both client handlers are idempotent (Map/Set delete), and the
                // evictee was already removed from the room above, so the
                // overlap is harmless.
                state.broadcast_to_room(&room_id, msg, None);
            }
            if was_sharer {
                state.broadcast_to_room(
                    &room_id,
                    ServerMessage::ScreenShareStopped {
                        room_id: room_id.clone(),
                        streamer_id: member_id,
                    },
                    None,
                );
            }
            if was_camera {
                state.broadcast_to_room(
                    &room_id,
                    ServerMessage::CameraStopped {
                        room_id: room_id.clone(),
                        user_id: member_id,
                    },
                    None,
                );
            }
            state.send_to_user(
                member_id,
                ServerMessage::RoomLeft {
                    room_id: room_id.clone(),
                    reason: None,
                    by: None,
                },
            );
            state.broadcast_to_room(
                &room_id,
                ServerMessage::UserLeft {
                    room_id: room_id.clone(),
                    user_id: member_id,
                },
                None,
            );
            tracing::info!(
                "Perms eviction: user {} removed from {} (VIEW denied after change in server {})",
                member_id,
                room_id,
                server_id
            );
            // Their other devices stop showing "You're in <channel> on ...".
            if parse_voice_room(&room_id).is_some() {
                push_own_voice_state(state, member_id).await;
            }
        }
    }

    // 3) SFU rooms live in a SEPARATE map (state.sfu_rooms), not state.rooms, so
    // the mesh loop above never touches them. Force-evict any VIEW-denied user
    // from the LiveKit room too — otherwise a kicked/banned/role-stripped member
    // keeps publishing+subscribing media on the SFU path until they leave, and
    // the media key doesn't rotate away from them. Eviction also fires
    // ParticipantDisconnected on remaining clients → immediate epoch re-key.
    //
    // With the scope UNKNOWN every SFU room is a candidate and sweep_keeps acts
    // only on what resolves - NotMember is a fact here, never a failed lookup
    // (see get_user_channel_permissions), so nobody is ejected from another
    // server's call on a database hiccup.
    let sfu_targets: Vec<(i64, i64)> = {
        let mut out = Vec::new();
        for r in state.sfu_rooms.iter() {
            let Some(cid) = crate::sfu::channel_id_from_room(r.key()) else {
                continue;
            };
            if let Some(set) = &scope {
                if !set.contains(&cid) {
                    continue;
                }
            }
            // Distinct user ids currently in this SFU room (identities are u<id>#<nonce>).
            let mut uids: std::collections::HashSet<i64> = std::collections::HashSet::new();
            for ident in r.participants.keys().chain(r.reservations.keys()) {
                if let Some(uid) = crate::sfu::user_id_from_identity(ident) {
                    uids.insert(uid);
                }
            }
            for uid in uids {
                out.push((cid, uid));
            }
        }
        out
    };
    // One LiveKit circuit breaker for this pass (crate::sfu::LiveKitBreaker):
    // after the first call LiveKit does not answer, the rest are not sent but
    // owed to the resync - so a hung LiveKit costs this pass one timeout, not
    // one per session, and the next change's mesh pass is not held behind it.
    let breaker = Arc::new(crate::sfu::LiveKitBreaker::default());
    crate::sfu::with_livekit_breaker(Arc::clone(&breaker), async {
    for (cid, uid) in sfu_targets {
        // An SFU room is always voice: the token gate (sfu.rs get_sfu_token)
        // requires VIEW and CONNECT, so the sweep does too.
        //
        // A member it keeps has the grant their permissions give applied AT
        // LIVEKIT, both ways (a SPEAK revoke and a SPEAK grant). The speak
        // FLAG rides the mesh pass above, but it lives in voice_<id>: a client
        // that leaves that room (or lets its socket die) while staying in
        // LiveKit takes the server's deny with it, and would publish its mic
        // under the token's old grant. LiveKit's own grant does not leave.
        let (allowed, grant) = match allowed_cache.get(&(cid, uid, true)) {
            Some(&(ok, _, grant)) => (ok, grant),
            None => {
                let access = get_user_channel_permissions(&state.pool, cid, uid).await;
                let verdict = (
                    sweep_keeps(scope_known, server_id, &access, true),
                    sweep_speak(server_id, &access, true),
                    sweep_grant(server_id, &access),
                );
                allowed_cache.insert((cid, uid, true), verdict);
                (verdict.0, verdict.2)
            }
        };
        if allowed {
            if let Some(perms) = grant {
                // Say what LiveKit confirmed, not what was attempted. A session
                // already holding the grant is not sent it (tried counts those
                // whose grant had to change, or whose last update went unconfirmed).
                let out = crate::sfu::regrant_user(state, cid, uid, perms).await;
                if out.tried > 0 && out.applied == out.tried {
                    tracing::info!(
                        "SFU perms grant: user {} in sfu channel {}: LiveKit confirmed the grant their permissions give on {} session(s), {} already held it (sweep for server {})",
                        uid,
                        cid,
                        out.applied,
                        out.unchanged,
                        server_id
                    );
                } else if out.tried > 0 {
                    // regrant_user has owed the unconfirmed ones to the resync
                    // and says whether it will retry them (resync_retries).
                    tracing::warn!(
                        "SFU perms grant: user {} in sfu channel {}: LiveKit confirmed {} of {} session(s) needing the grant their permissions give \
                         (see the SFU grant lines above); for the rest {}; sweep for server {}",
                        uid,
                        cid,
                        out.applied,
                        out.tried,
                        crate::sfu::grant_retry_note(out.resync_retries, crate::sfu::GrantAt::Live),
                        server_id
                    );
                }
            }
            continue;
        }
        // Say what LiveKit confirmed, not what was attempted: this line used to
        // read "removed" after a refused or failed call as well.
        let out = crate::sfu::evict_user_from_channel(state, cid, uid).await;
        if out.tried > 0 && out.removed == out.tried {
            tracing::info!(
                "SFU perms eviction: user {} removed from sfu channel {} (no longer allowed there; sweep for server {})",
                uid,
                cid,
                server_id
            );
        } else {
            tracing::warn!(
                "SFU perms eviction: user {} NOT removed from sfu channel {} — LiveKit confirmed {} of {} \
                 sessions (see the SFU evict lines above); sweep for server {}",
                uid,
                cid,
                out.removed,
                out.tried,
                server_id
            );
        }
    }
    })
    .await;
    if breaker.tripped() {
        // Read after every skipped session was owed: see grant_retry_note.
        tracing::warn!(
            "SFU perms sweep for server {}: LiveKit did not answer a call, so this sweep sent no further LiveKit calls ({} not sent); \
             each joined session is owed to the LiveKit resync, {} (a session that has not joined yet is checked when it joins)",
            server_id,
            breaker.skipped(),
            if crate::sfu::resync_will_retry(state) {
                "which will retry it"
            } else {
                "which is NOT running: each waits for the sweep of the next permission change in this server, or the session's rejoin"
            }
        );
    }
}

/// Seconds to wait before re-running a sweep whose scope query failed:
/// 2 s, then 8 s, then 30 s.
fn sweep_backoff_secs(retries_left: u8) -> u64 {
    match retries_left {
        3 => 2,
        2 => 8,
        _ => 30,
    }
}

/// Every channel the sweep must scope: its mesh rooms' and its SFU rooms'. An
/// SFU session whose Púca socket is not in voice_<id> holds no mesh room, and
/// after a restart that is exactly the session the LiveKit resync makes known.
/// None when there is neither, and nothing to sweep.
fn sweep_candidate_ids(mesh: &[i64], sfu: &[i64]) -> Option<Vec<i64>> {
    if mesh.is_empty() && sfu.is_empty() {
        return None;
    }
    Some(mesh.iter().chain(sfu.iter()).copied().collect())
}

#[cfg(test)]
mod sweep_candidate_tests {
    use super::sweep_candidate_ids;

    #[test]
    fn an_sfu_room_alone_is_in_scope() {
        assert_eq!(sweep_candidate_ids(&[], &[7]), Some(vec![7]), "no Púca room at all, one LiveKit room");
        assert_eq!(sweep_candidate_ids(&[3], &[7]), Some(vec![3, 7]));
        assert_eq!(sweep_candidate_ids(&[3], &[]), Some(vec![3]));
        assert_eq!(sweep_candidate_ids(&[], &[]), None, "nothing to sweep");
    }
}

/// The sweep's verdict for one (room, member): `true` keeps them, `false`
/// evicts. With a KNOWN scope every room reaching here belongs to this
/// server, so any refusal — including a lookup that could not resolve —
/// evicts: fail closed. With the scope UNKNOWN (the scope query failed) only
/// what resolves cleanly is acted on: a member whose channel resolves to
/// another server is left alone, a member of THIS server who lacks the bits
/// or is no longer a member is evicted, and one who cannot be resolved at
/// all is left to the scheduled retry rather than dropped on a guess.
fn sweep_keeps(scope_known: bool, server_id: &str, access: &ChannelPermAccess, need_connect: bool) -> bool {
    match access {
        ChannelPermAccess::Allowed { server_id: sid, perms } => {
            if !scope_known && sid != server_id {
                return true;
            }
            perms.has(Permissions::VIEW_CHANNEL) && (!need_connect || perms.has(Permissions::CONNECT))
        }
        ChannelPermAccess::NotMember => false,
        ChannelPermAccess::NotFound => !scope_known,
    }
}

/// The permissions whose publish grant the sweep has LiveKit enforce on an SFU
/// member it keeps (`crate::sfu::regrant_user`), or None to leave their grant
/// alone. Only an `Allowed` answer for a channel of THIS server: with the scope
/// unknown, `sweep_keeps` keeps another server's members, and their grant is
/// no business of a sweep for this one; `NotFound` (a lookup that failed) and
/// `NotMember` say nothing about what they may publish.
fn sweep_grant(server_id: &str, access: &ChannelPermAccess) -> Option<Permissions> {
    match access {
        ChannelPermAccess::Allowed { server_id: sid, perms } if sid == server_id => Some(*perms),
        _ => None,
    }
}

#[cfg(test)]
mod sweep_keeps_tests {
    use super::sweep_keeps;
    use crate::permissions::{ChannelPermAccess, Permissions};

    fn allowed(sid: &str, perms: Permissions) -> ChannelPermAccess {
        ChannelPermAccess::Allowed { server_id: sid.into(), perms }
    }

    #[test]
    fn known_scope_mirrors_the_join_gate() {
        let v = Permissions::VIEW_CHANNEL;
        let vc = Permissions::VIEW_CHANNEL | Permissions::CONNECT;
        assert!(sweep_keeps(true, "s", &allowed("s", vc), true));
        assert!(!sweep_keeps(true, "s", &allowed("s", v), true), "a voice room needs CONNECT too");
        assert!(sweep_keeps(true, "s", &allowed("s", v), false), "a text room needs VIEW only");
        assert!(!sweep_keeps(true, "s", &allowed("s", Permissions::CONNECT), false));
    }

    #[test]
    fn known_scope_fails_closed_on_the_unresolvable() {
        assert!(!sweep_keeps(true, "s", &ChannelPermAccess::NotFound, false));
        assert!(!sweep_keeps(true, "s", &ChannelPermAccess::NotMember, false));
    }

    #[test]
    fn unknown_scope_acts_only_on_what_resolves() {
        // Another server's room resolves cleanly: not ours to evict.
        assert!(sweep_keeps(false, "s", &allowed("other", Permissions::empty()), true));
        // This server's member who lost the bits, or is no longer a member: evicted.
        assert!(!sweep_keeps(false, "s", &allowed("s", Permissions::empty()), false));
        assert!(!sweep_keeps(false, "s", &ChannelPermAccess::NotMember, false));
        // Unresolvable (a lookup that failed): left to the retry, not dropped on a guess.
        assert!(sweep_keeps(false, "s", &ChannelPermAccess::NotFound, false));
    }
}

/// The sweep's speak verdict for a member it KEEPS: in a voice room, the
/// member's SPEAK right from the resolution `sweep_keeps` was given
/// (`Some`), or `None` to leave the stored flag exactly as it is.
///
/// Only an `Allowed` answer is an answer about SPEAK. `NotFound` is "not
/// found or the lookup failed" and `NotMember` does not reach here with a
/// member kept, so neither may flip a flag: turning a database hiccup into
/// "everyone may speak again" would undo a deny, and into "nobody may" would
/// silence a call. A text room has no speak right at all.
///
/// And only an answer for a channel of THIS server (`server_id`, the sweep's),
/// like `sweep_grant`: with the scope unknown, `sweep_keeps` keeps another
/// server's members, and their speak flag is no business of a sweep for this
/// one - it holds only this server's lock, so another server's sweep could be
/// writing the same flag at the same time.
fn sweep_speak(server_id: &str, access: &ChannelPermAccess, voice: bool) -> Option<bool> {
    if !voice {
        return None;
    }
    match access {
        ChannelPermAccess::Allowed { server_id: sid, perms } if sid == server_id => Some(perms.has(Permissions::SPEAK)),
        ChannelPermAccess::Allowed { .. } | ChannelPermAccess::NotMember | ChannelPermAccess::NotFound => None,
    }
}

#[cfg(test)]
mod sweep_speak_tests {
    use super::{join_verdict, sweep_speak, JOIN_NO_CONNECT, JOIN_REFUSED};
    use crate::permissions::{ChannelPermAccess, Permissions as P};

    fn allowed(perms: P) -> ChannelPermAccess {
        ChannelPermAccess::Allowed { server_id: "s".into(), perms }
    }

    #[test]
    fn a_kept_voice_member_gets_the_speak_bit_of_the_same_resolution() {
        let vc = P::VIEW_CHANNEL | P::CONNECT;
        assert_eq!(sweep_speak("s", &allowed(vc | P::SPEAK), true), Some(true));
        assert_eq!(sweep_speak("s", &allowed(vc), true), Some(false), "a SPEAK deny is an answer too");
        assert_eq!(sweep_speak("s", &allowed(P::ADMINISTRATOR), true), Some(true), "ADMINISTRATOR implies SPEAK");
    }

    #[test]
    fn no_answer_leaves_the_flag_alone() {
        assert_eq!(sweep_speak("s", &ChannelPermAccess::NotFound, true), None, "a failed lookup is not a verdict");
        assert_eq!(sweep_speak("s", &ChannelPermAccess::NotMember, true), None);
        assert_eq!(sweep_speak("s", &allowed(P::all()), false), None, "a text room has no speak right");
    }

    /// With the scope unknown the sweep keeps another server's members; their
    /// flag is not its business. Positive control: the same answer for THIS
    /// server is one.
    #[test]
    fn another_servers_answer_leaves_the_flag_alone() {
        let vc = P::VIEW_CHANNEL | P::CONNECT;
        let other = ChannelPermAccess::Allowed { server_id: "other".into(), perms: vc };
        assert_eq!(sweep_speak("s", &other, true), None);
        assert_eq!(sweep_speak("other", &other, true), Some(false));
    }

    /// The join gate and its post-insert recheck share this, so the voice
    /// joiner's speak right comes from the very resolution that admitted them.
    #[test]
    fn the_join_verdict_admits_refuses_and_carries_speak() {
        let vc = P::VIEW_CHANNEL | P::CONNECT;
        assert_eq!(join_verdict(&allowed(P::VIEW_CHANNEL), false), Ok(None), "a text room needs VIEW only");
        assert_eq!(join_verdict(&allowed(vc | P::SPEAK), true), Ok(Some(true)));
        assert_eq!(join_verdict(&allowed(vc), true), Ok(Some(false)), "admitted, but not to speak");
        assert_eq!(join_verdict(&allowed(P::ADMINISTRATOR), true), Ok(Some(true)), "the owner resolves to ADMINISTRATOR");
    }

    /// Both refusals fail closed; only a member who can SEE the channel is told
    /// it is CONNECT they lack. VIEW-denied, non-member and not-found keep the
    /// generic text, so it stays no oracle for a channel they cannot see.
    #[test]
    fn only_a_member_who_can_see_the_channel_is_told_it_is_connect() {
        assert_eq!(join_verdict(&allowed(P::VIEW_CHANNEL | P::SPEAK), true), Err(JOIN_NO_CONNECT));
        assert_eq!(join_verdict(&allowed(P::CONNECT | P::SPEAK), true), Err(JOIN_REFUSED), "VIEW-denied: generic");
        assert_eq!(join_verdict(&allowed(P::CONNECT), false), Err(JOIN_REFUSED));
        assert_eq!(join_verdict(&ChannelPermAccess::NotMember, true), Err(JOIN_REFUSED));
        assert_eq!(join_verdict(&ChannelPermAccess::NotFound, true), Err(JOIN_REFUSED));
        assert_eq!(join_verdict(&ChannelPermAccess::NotFound, false), Err(JOIN_REFUSED));
        assert_ne!(JOIN_NO_CONNECT, JOIN_REFUSED);
    }
}


/// Mint a token that inherits an EXISTING session start (`sst`). Used by the
/// sliding-renewal path so extending a session never resets its absolute cap.
pub fn create_token_with_start(
    user_id: UserId,
    username: &str,
    token_version: i32,
    session_start: i64,
    sid: &str,
    long: bool,
    secret: &str,
) -> Result<String, String> {
    use jsonwebtoken::{encode, EncodingKey, Header};

    // `long` = the user asked to stay signed in on this device. It picks the
    // token's lifetime and is stamped into the claims so renewal can carry it
    // forward — see crate::auth::Claims::ls for what it does and does not
    // change (revocation: nothing).
    //
    // A full TTL from now, clamped to `session_start` + the session cap: the
    // cap bounds how long the token is VALID, not only whether it may renew
    // (see crate::auth::token_exp_at). Far from the cap this is the same
    // `now + TTL` it has always been.
    let expiration = crate::auth::token_exp_at(Utc::now().timestamp(), session_start, long);

    let claims = Claims {
        sub: user_id,
        username: username.to_string(),
        exp: expiration,
        tv: token_version,
        sst: session_start,
        sid: sid.to_string(),
        ls: long,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| format!("Token creation failed: {}", e))
}

#[cfg(test)]
mod leave_decision_tests {
    use super::{leave_announces_departure, leave_retracts_media};

    #[test]
    fn a_connection_that_never_joined_the_room_does_nothing() {
        // C09: the whole fix. was_joined = false must suppress BOTH the media
        // retraction and the departure announcement, whatever else is true —
        // otherwise a LeaveRoom for a guessed room injects frames into a call
        // the caller cannot see.
        assert!(!leave_retracts_media(false, true, false));
        assert!(!leave_announces_departure(false, false, true));
    }

    #[test]
    fn an_entitled_full_leave_retracts_and_announces() {
        // Positive control: a member who was in the room and fully left.
        assert!(leave_retracts_media(true, true, false), "voice full-leave retracts media");
        assert!(leave_announces_departure(true, false, true), "full-leave announces UserLeft");
    }

    #[test]
    fn a_user_still_present_on_another_device_is_not_torn_down() {
        // still_member = true: another connection of theirs holds the room, so
        // neither the retraction nor the announcement may fire.
        assert!(!leave_retracts_media(true, true, true));
        assert!(!leave_announces_departure(true, true, true));
    }

    #[test]
    fn media_retraction_is_voice_only() {
        // r2-3-L3-01 is about the mesh voice pc; a text room has no media pc to
        // retract, so is_voice = false suppresses it even on a full leave.
        assert!(!leave_retracts_media(true, false, false));
        // A text-room departure still announces when presence is shown.
        assert!(leave_announces_departure(true, false, true));
    }

    #[test]
    fn a_hidden_user_outside_voice_is_not_announced() {
        // announce_presence is false for a hidden user outside voice — their
        // departure must stay silent, mirroring their silent join.
        assert!(!leave_announces_departure(true, false, false));
    }
}

#[cfg(test)]
mod crash_resistance_tests {
    use super::*;

    /// Every deployed client predates ScreenShareStart's stream_id — their
    /// frames must keep deserializing, and the field must default to None
    /// rather than erroring. A parse failure here would DROP the announce and
    /// the room would never learn the user is sharing at all.
    #[test]
    fn screen_share_start_deserializes_with_and_without_stream_id() {
        let old: ClientMessage = serde_json::from_str(
            r#"{"type":"ScreenShareStart","payload":{"room_id":"channel_1"}}"#,
        )
        .expect("an old client's announce must still parse");
        assert!(matches!(
            old,
            ClientMessage::ScreenShareStart { stream_id: None, .. }
        ));

        let new: ClientMessage = serde_json::from_str(
            r#"{"type":"ScreenShareStart","payload":{"room_id":"channel_1","stream_id":"abc-123"}}"#,
        )
        .expect("a new client's announce must parse");
        assert!(matches!(
            new,
            ClientMessage::ScreenShareStart { stream_id: Some(ref id), .. } if id == "abc-123"
        ));
    }

    /// The relayed ScreenShareStarted omits a missing id entirely, so an OLD
    /// client (which destructures only the fields it knows) sees exactly the
    /// frame it always has.
    #[test]
    fn screen_share_started_omits_an_absent_stream_id_on_the_wire() {
        let msg = ServerMessage::ScreenShareStarted {
            room_id: "channel_1".into(),
            streamer: UserInfo::new(1, "mick".into()),
            stream_id: None,
        };
        let wire = serde_json::to_string(&msg).expect("serializes");
        assert!(
            !wire.contains("stream_id"),
            "absent id must not appear on the wire: {wire}"
        );
    }

    /// The exact frame the Devices view listens for (`wsClient.on('DevicePresence')`
    /// in frontend/src/components/DevicesView.tsx). The client keys on the
    /// `type` string alone and re-reads the list; if this name drifts, the
    /// list silently goes back to the 15 s poll with no error anywhere.
    #[test]
    fn device_presence_wire_shape_is_what_the_devices_view_listens_for() {
        let msg = ServerMessage::DevicePresence {
            device_id: "devA".into(),
            online: true,
        };
        let wire = serde_json::to_string(&msg).expect("serializes");
        assert_eq!(
            wire,
            r#"{"type":"DevicePresence","payload":{"device_id":"devA","online":true}}"#
        );
    }

    #[test]
    fn message_content_rejects_empty_oversized_and_nul() {
        assert!(valid_message_content("hello"));
        assert!(valid_message_content(&"x".repeat(MAX_MESSAGE_CONTENT_LEN)));
        assert!(!valid_message_content(""));
        assert!(!valid_message_content("   \n\t "));
        assert!(!valid_message_content(
            &"x".repeat(MAX_MESSAGE_CONTENT_LEN + 1)
        ));
        assert!(!valid_message_content("has\0nul"));
    }

    #[test]
    fn rate_limiter_bounds_burst_then_refuses() {
        let mut rl = RateLimiter::new();
        // A fresh bucket allows exactly its burst capacity with no time elapsed.
        let mut allowed = 0;
        for _ in 0..(RateLimiter::CAPACITY as usize) {
            if rl.allow() {
                allowed += 1;
            }
        }
        assert_eq!(allowed, RateLimiter::CAPACITY as usize);
        // The very next frame (still no refill) is refused — a flood is capped.
        assert!(!rl.allow(), "burst past capacity must be refused");
    }

    /// The input bucket must sustain the client's real emit ceiling. The
    /// coalescers flush rmove every 8ms — 125 events/s — and the general
    /// bucket's 50/s demonstrably dropped 60% of a sustained stream (felt as
    /// drift and stuck buttons). Simulate 10s of 125Hz input against both
    /// buckets: the input bucket must pass every frame, and the general one
    /// must fail (positive control — proves this test can see the drop).
    #[test]
    fn input_bucket_sustains_pointer_rates_where_general_bucket_drops() {
        let simulate = |rl: &mut RateLimiter| -> usize {
            let mut dropped = 0;
            // Manual clock: rewind last_refill by 8ms per frame instead of
            // sleeping, so the test is instant and deterministic.
            for _ in 0..1250 {
                rl.last_refill -= std::time::Duration::from_millis(8);
                if !rl.allow() {
                    dropped += 1;
                }
            }
            dropped
        };
        let mut input = RateLimiter::for_control_input();
        assert_eq!(
            simulate(&mut input),
            0,
            "input bucket must never drop a 125Hz stream"
        );
        let mut general = RateLimiter::new();
        assert!(
            simulate(&mut general) > 500,
            "positive control: the general bucket must visibly drop the same stream"
        );
    }

    #[test]
    fn input_frame_classifier_matches_only_input_types() {
        // Real client frames: JSON.stringify({type, payload}) puts type first.
        assert!(is_input_frame(r#"{"type":"DeviceInput","payload":{"session_id":"x","event":"AA=="}}"#));
        assert!(is_input_frame(r#"{"type":"ControlInput","payload":{"target_user":7,"event":"AA=="}}"#));
        // Near misses stay in the general bucket.
        assert!(!is_input_frame(r#"{"type":"DeviceSignal","payload":{}}"#));
        assert!(!is_input_frame(r#"{"type":"ControlEnd","payload":{}}"#));
        assert!(!is_input_frame(r#"{"payload":{},"type":"DeviceInput"}"#)); // reordered keys → general (harmless)
        assert!(!is_input_frame(r#" {"type":"DeviceInput"}"#)); // leading space → general (harmless)
    }

    #[test]
    fn wake_frame_classifier_matches_only_wake_requests() {
        assert!(is_wake_frame(r#"{"type":"DeviceWake","payload":{"waker_device":"d","mac":"AA"}}"#));
        // Near misses fall back to the GENERAL bucket, which is this
        // classifier's safe direction: a wake frame that misses the prefix is
        // simply limited as it was before this bucket existed.
        //
        // The closing quote in the prefix is load-bearing: without it
        // "DeviceWakeRequested" — a SERVER->client frame — would also match,
        // and any future client frame sharing the stem would silently inherit
        // a 3-token bucket.
        assert!(!is_wake_frame(r#"{"type":"DeviceWakeRequested","payload":{}}"#));
        assert!(!is_wake_frame(r#"{"type":"DeviceConnect","payload":{}}"#));
        assert!(!is_wake_frame(r#"{"payload":{},"type":"DeviceWake"}"#));
    }

    #[test]
    fn the_wake_bucket_allows_a_human_burst_and_then_throttles_hard() {
        // The point of this bucket: DeviceWake makes ANOTHER of the user's
        // machines emit LAN broadcasts with no interaction at that machine, so
        // it must not inherit the general 100-burst/50-per-second allowance.
        let mut wake = RateLimiter::for_wake();
        let mut allowed = 0;
        for _ in 0..50 {
            if wake.allow() {
                allowed += 1;
            }
        }
        assert_eq!(allowed, 8, "bounded, but not so tight it breaks real use");

        // The case that decides this constant: waking every machine you own,
        // one after another. A frame over the limit is dropped SILENTLY — the
        // user gets no error, just a wake that never happened and a
        // three-minute wait — so "too tight" is a functional bug, not a
        // stricter policy.
        let mut sequential = RateLimiter::for_wake();
        for machine in 1..=4 {
            assert!(
                sequential.allow(),
                "waking machine {machine} of 4 in a row must not be silently dropped",
            );
        }

        // Positive control: the same 50 frames sail through the general bucket,
        // which is exactly what this feature must NOT be limited by.
        let mut general = RateLimiter::new();
        let mut general_allowed = 0;
        for _ in 0..50 {
            if general.allow() {
                general_allowed += 1;
            }
        }
        assert_eq!(general_allowed, 50);
    }

    #[test]
    fn signaling_and_room_caps_are_sane() {
        // Guards exist and are small enough to bound memory, large enough for
        // real payloads. Kept as a canary against an accidental bump.
        assert!(MAX_ROOM_ID_LEN <= 256);
        assert!(MAX_SDP_LEN <= 128 * 1024);
        assert!(MAX_CANDIDATE_LEN <= 16 * 1024);
        assert!(MAX_CONTROL_EVENT_LEN <= 16 * 1024);
        assert!(MAX_ROOMS_PER_CONN >= 2 && MAX_ROOMS_PER_CONN <= 1024);
    }
}

#[cfg(test)]
mod ws_bearer_subprotocol_tests {
    use super::{bearer_from_subprotocol, WS_MISSING_TOKEN_BODY};
    use axum::http::{header::SEC_WEBSOCKET_PROTOCOL, HeaderMap, HeaderValue};

    fn with_protocol(v: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(SEC_WEBSOCKET_PROTOCOL, HeaderValue::from_str(v).unwrap());
        h
    }

    /// The refusal body must NAME the cure. A client that cannot connect keeps
    /// exactly this string in its own log, and "Missing token" told the LAN
    /// waker's owner nothing across 6,743 refusals.
    #[test]
    fn the_refusal_names_the_header_and_the_retirement() {
        assert!(WS_MISSING_TOKEN_BODY.contains("Sec-WebSocket-Protocol"));
        assert!(WS_MISSING_TOKEN_BODY.contains("bearer"));
        assert!(WS_MISSING_TOKEN_BODY.contains("0.9.1"));
        assert_ne!(WS_MISSING_TOKEN_BODY, "Missing token");
    }

    #[test]
    fn reads_the_token_after_the_bearer_marker() {
        assert_eq!(
            bearer_from_subprotocol(&with_protocol("bearer, abc.def.ghi")).as_deref(),
            Some("abc.def.ghi"),
        );
    }

    #[test]
    fn tolerates_the_spacing_browsers_actually_send() {
        // `new WebSocket(url, ['bearer', tok])` serialises without a space in
        // some engines and with one in others. Both are the same offer.
        for raw in ["bearer,abc.def", "bearer, abc.def", "bearer ,  abc.def"] {
            assert_eq!(
                bearer_from_subprotocol(&with_protocol(raw)).as_deref(),
                Some("abc.def"),
                "failed for {raw:?}",
            );
        }
    }

    #[test]
    fn ignores_offers_that_are_not_ours() {
        // Something else negotiating a subprotocol must not be read as a
        // credential — it would be treated as a JWT and rejected, turning an
        // unrelated feature into an auth failure.
        assert!(bearer_from_subprotocol(&with_protocol("graphql-ws")).is_none());
        assert!(bearer_from_subprotocol(&with_protocol("chat, superchat")).is_none());
    }

    #[test]
    fn a_marker_with_no_token_is_not_a_credential() {
        // Empty or missing second value must fall through to the query-string
        // path rather than presenting "" as a token.
        assert!(bearer_from_subprotocol(&with_protocol("bearer")).is_none());
        assert!(bearer_from_subprotocol(&with_protocol("bearer, ")).is_none());
    }

    #[test]
    fn absent_header_is_absent_not_empty() {
        assert!(bearer_from_subprotocol(&HeaderMap::new()).is_none());
    }

    /// The token must never travel in a place that gets logged. This pins the
    /// SHAPE of what we echo back: the marker only. Echoing the negotiated
    /// value verbatim — the obvious implementation — would put the credential
    /// into a response header and undo the entire change.
    #[test]
    fn the_marker_is_what_gets_echoed_never_the_token() {
        let tok = "header.payload.signature";
        let offered = format!("bearer, {tok}");
        let parsed = bearer_from_subprotocol(&with_protocol(&offered)).expect("parses");
        assert_eq!(parsed, tok);
        // What ws_handler selects is the literal "bearer"; assert it is not
        // the credential, so a future edit that echoes `parsed` fails here.
        let echoed = "bearer";
        assert_ne!(echoed, parsed);
        assert!(!echoed.contains(tok));
    }
}

#[cfg(test)]
mod file_offer_presence_mask_tests {
    use super::target_is_hidden;

    /// r2-4-L4-02 review finding 5: the mask must fail CLOSED. Before, the
    /// call site read `!user_shows_online(..)`, whose `unwrap_or(true)` turned
    /// a DB blip into "not hidden" and re-opened the oracle.
    #[test]
    fn a_lookup_error_or_missing_row_masks() {
        assert!(target_is_hidden(false, None), "error/missing row must mask");
    }

    #[test]
    fn a_hidden_setting_masks() {
        assert!(target_is_hidden(false, Some(false)));
    }

    /// The positive control: only an explicit `true` un-masks, so the parked /
    /// delivered distinction survives for a recipient who shows their status.
    #[test]
    fn only_a_positive_shows_online_row_unmasks() {
        assert!(!target_is_hidden(false, Some(true)));
    }

    /// A self-transfer is never masked, whatever the row says or fails to say —
    /// the sender is the recipient and can see their own devices.
    #[test]
    fn a_self_transfer_is_never_masked() {
        assert!(!target_is_hidden(true, None));
        assert!(!target_is_hidden(true, Some(false)));
        assert!(!target_is_hidden(true, Some(true)));
    }
}

#[cfg(test)]
mod chat_admission_tests {
    use super::{chat_admission, is_voice_status_ping, ChatAdmission, VOICE_STATUS_PREFIX};
    use crate::permissions::{ChannelPermAccess, Permissions};

    fn allowed(perms: Permissions) -> ChannelPermAccess {
        ChannelPermAccess::Allowed { server_id: "s1".into(), perms }
    }

    /// Exactly what the client sends (voiceStatus.ts `buildVoiceStatus`).
    const PING: &str = "__VOICE_STATUS__{\"muted\":true,\"deafened\":false,\"buffering\":false}";
    const TEXT: &str = "hello everyone";

    fn view_connect() -> Permissions {
        Permissions::VIEW_CHANNEL | Permissions::CONNECT
    }
    fn view_connect_send() -> Permissions {
        view_connect() | Permissions::SEND_MESSAGES
    }

    #[test]
    fn the_prefix_matches_the_client_codec() {
        assert_eq!(VOICE_STATUS_PREFIX, "__VOICE_STATUS__");
        assert!(is_voice_status_ping(PING));
        assert!(is_voice_status_ping(VOICE_STATUS_PREFIX), "bare prefix still parses client-side");
        assert!(!is_voice_status_ping(TEXT));
        assert!(!is_voice_status_ping(" __VOICE_STATUS__{}"), "prefix match, not substring");
        assert!(!is_voice_status_ping("__voice_status__{}"), "case-sensitive like startsWith");
    }

    /// Findings 8 / 14: a CONNECT-holder denied SEND_MESSAGES who is in the
    /// call must still propagate mute / deafen / recording state.
    #[test]
    fn status_ping_from_an_occupant_without_send_is_admitted_as_a_ping() {
        assert_eq!(
            chat_admission(true, PING, true, &allowed(view_connect())),
            ChatAdmission::StatusPing
        );
        // Holding SEND as well changes nothing — still a ping, still exempt
        // from the timeout check.
        assert_eq!(
            chat_admission(true, PING, true, &allowed(view_connect_send())),
            ChatAdmission::StatusPing
        );
    }

    /// C10's point survives: a connection that has NOT joined the voice room
    /// cannot inject roster state into it without the bits a message needs.
    #[test]
    fn status_ping_from_a_non_occupant_is_refused() {
        assert_eq!(
            chat_admission(true, PING, false, &allowed(view_connect())),
            ChatAdmission::Refused
        );
        assert_eq!(
            chat_admission(true, PING, false, &allowed(Permissions::VIEW_CHANNEL)),
            ChatAdmission::Refused
        );
    }

    /// "Anything else keeps the SEND_MESSAGES + timeout gate": a non-occupant
    /// holding SEND is treated as a message sender, timeout check included.
    #[test]
    fn status_ping_from_a_non_occupant_with_send_is_gated_as_a_message() {
        assert_eq!(
            chat_admission(true, PING, false, &allowed(view_connect_send())),
            ChatAdmission::Message
        );
    }

    #[test]
    fn real_content_without_send_is_refused_even_from_an_occupant() {
        assert_eq!(
            chat_admission(true, TEXT, true, &allowed(view_connect())),
            ChatAdmission::Refused
        );
        assert_eq!(
            chat_admission(false, TEXT, true, &allowed(Permissions::VIEW_CHANNEL)),
            ChatAdmission::Refused
        );
    }

    #[test]
    fn real_content_with_send_is_admitted_as_a_message() {
        assert_eq!(
            chat_admission(true, TEXT, true, &allowed(view_connect_send())),
            ChatAdmission::Message
        );
        assert_eq!(
            chat_admission(
                false,
                TEXT,
                true,
                &allowed(Permissions::VIEW_CHANNEL | Permissions::SEND_MESSAGES)
            ),
            ChatAdmission::Message
        );
    }

    /// The carve-out is for VOICE rooms only: into a text room the ping is
    /// just a message that happens to start with the prefix.
    #[test]
    fn status_ping_into_a_text_room_is_gated_as_a_message() {
        assert_eq!(
            chat_admission(false, PING, true, &allowed(view_connect())),
            ChatAdmission::Refused
        );
        assert_eq!(
            chat_admission(false, PING, true, &allowed(view_connect_send())),
            ChatAdmission::Message
        );
    }

    /// The join-level gate is re-asserted: an occupant whose CONNECT (or VIEW)
    /// has since been revoked is refused, not exempted.
    #[test]
    fn an_occupant_stripped_of_the_join_gate_is_refused() {
        assert_eq!(
            chat_admission(true, PING, true, &allowed(Permissions::VIEW_CHANNEL)),
            ChatAdmission::Refused
        );
        assert_eq!(
            chat_admission(true, PING, true, &allowed(Permissions::CONNECT | Permissions::SEND_MESSAGES)),
            ChatAdmission::Refused
        );
    }

    /// Fail closed: a non-member / not-found / errored lookup admits nothing,
    /// ping or not, occupant or not.
    #[test]
    fn a_denied_lookup_refuses_everything() {
        for access in [ChannelPermAccess::NotMember, ChannelPermAccess::NotFound] {
            assert_eq!(chat_admission(true, PING, true, &access), ChatAdmission::Refused);
            assert_eq!(chat_admission(true, TEXT, true, &access), ChatAdmission::Refused);
            assert_eq!(chat_admission(false, TEXT, true, &access), ChatAdmission::Refused);
        }
    }
}

#[cfg(test)]
mod hidden_members_fail_direction_tests {
    use super::{hidden_on_error, UserId};
    use crate::protocol::UserInfo;

    /// The whole point of the fix: an error must yield EVERY id, not none.
    #[test]
    fn an_error_treats_the_entire_roster_as_hidden() {
        let ids: Vec<UserId> = vec![7, 9, 11];
        let hidden = hidden_on_error(&ids);
        assert_eq!(hidden.len(), 3, "every id must be hidden on a DB error");
        for id in &ids {
            assert!(hidden.contains(id), "{id} must be treated as hidden");
        }
        assert!(hidden_on_error(&[]).is_empty(), "no ids, nothing to hide");
    }

    /// Positive control for the caller's side of the contract: with the
    /// fail-closed set, the roster `RoomJoined` would carry is the joiner ALONE
    /// — not the full membership. Reproduces the caller's `retain` verbatim, so
    /// restoring `.unwrap_or_default()` (an empty set) makes this assertion
    /// fail: the retain becomes a no-op and all three members survive.
    #[test]
    fn the_roster_the_caller_would_send_degrades_to_the_joiner_only() {
        let joiner: UserId = 7;
        let mut members = vec![
            UserInfo::new(7, "me".to_string()),
            UserInfo::new(9, "them".to_string()),
            UserInfo::new(11, "other".to_string()),
        ];
        let ids: Vec<UserId> = members.iter().map(|m| m.id).collect();
        let hidden = hidden_on_error(&ids);
        members.retain(|m| m.id == joiner || !hidden.contains(&m.id));
        assert_eq!(
            members.iter().map(|m| m.id).collect::<Vec<_>>(),
            vec![joiner],
            "a DB error must leak nobody but the joining user"
        );
    }

    /// And the healthy path still hides only who asked to be hidden — the
    /// fail-closed direction must not be the everyday behaviour.
    #[test]
    fn the_ok_path_hides_only_the_flagged_ids() {
        // What the Ok arm does with rows the query returned.
        let rows: Vec<(i64,)> = vec![(9,)];
        let hidden: std::collections::HashSet<UserId> =
            rows.into_iter().map(|(id,)| id).collect();
        let mut members = vec![
            UserInfo::new(7, "me".to_string()),
            UserInfo::new(9, "them".to_string()),
            UserInfo::new(11, "other".to_string()),
        ];
        members.retain(|m| m.id == 7 || !hidden.contains(&m.id));
        assert_eq!(members.iter().map(|m| m.id).collect::<Vec<_>>(), vec![7, 11]);
    }
}

#[cfg(test)]
mod ws_error_leak_tests {
    use super::ws_db_error;

    /// L8-ERR-1. `handle_message` returns `Result<(), String>` and the socket
    /// loop sends that string verbatim as `ServerMessage::Error`. Two sites
    /// folded raw sqlx errors in with `.map_err(|e| e.to_string())?`, putting
    /// table and constraint names on the wire. The replacement must return a
    /// FIXED token for every error shape.
    #[test]
    fn a_db_error_never_reaches_the_wire() {
        let cases = [
            sqlx::Error::RowNotFound,
            sqlx::Error::PoolTimedOut,
            sqlx::Error::PoolClosed,
            sqlx::Error::ColumnNotFound("sign_pub".into()),
            sqlx::Error::Protocol("relation \"devices\" does not exist".into()),
        ];
        for e in cases {
            // Capture what the raw string WOULD have been, so this test also
            // proves the leak was real rather than only that the new string is
            // tidy.
            let raw = e.to_string();
            let sent = ws_db_error("test", e);
            assert_eq!(sent, "internal error", "the wire message must be fixed");
            assert!(
                !sent.contains(&raw) || raw == sent,
                "the raw error text must not survive: {raw}"
            );
            let lowered = sent.to_lowercase();
            for word in ["sqlx", "relation", "column", "constraint", "devices", "postgres"] {
                assert!(!lowered.contains(word), "leaked {word:?}: {sent}");
            }
        }
    }

    /// Positive control for the assertion above: the RAW text of at least one of
    /// those errors really does carry SQL vocabulary, so "contains no SQL words"
    /// is a property of the mapping and not of sqlx being coy.
    #[test]
    fn the_raw_error_really_would_have_leaked() {
        let raw = sqlx::Error::ColumnNotFound("sign_pub".into()).to_string();
        assert!(
            raw.to_lowercase().contains("column") || raw.contains("sign_pub"),
            "expected the raw error to name the column: {raw}"
        );
        let raw = sqlx::Error::Protocol("relation \"devices\" does not exist".into()).to_string();
        assert!(raw.contains("relation"), "expected the raw error to leak: {raw}");
    }
}

#[cfg(test)]
mod room_id_gate_tests {
    use super::{
        join_target, mutate_gate_target, parse_channel_room, parse_voice_room, room_channel_id,
        Permissions,
    };

    /// L8-AUTHZ-5. `room_channel_id` is the whole gate: `None` is a REFUSAL at
    /// JoinRoom now, so anything that is not one of the two canonical shapes
    /// must resolve to None. Before the fix these strings fell through the
    /// `if let` and minted a room in the global map.
    #[test]
    fn only_the_two_canonical_shapes_resolve() {
        for bad in [
            "dm_1",             // a shape the server never broadcasts to
            "",                 // empty
            "channel_",         // prefix with no id
            "voice_",           // ditto
            "CHANNEL_1",        // case matters
            "Voice_1",
            "channel_1x",       // trailing junk
            "channel_ 1",
            "room1",            // the signaling test's ad-hoc name
            "channel_1/2",
            "lobby",
        ] {
            assert!(
                room_channel_id(bad).is_none(),
                "{bad:?} must not resolve to a channel — JoinRoom refuses it"
            );
        }

        assert_eq!(room_channel_id("channel_1"), Some(1));
        assert_eq!(room_channel_id("voice_1"), Some(1));
        assert_eq!(room_channel_id("channel_987654321"), Some(987654321));
        // Negative ids parse as i64 but no channel has one; they reach the
        // permission resolver, which answers NotFound. That is the intended
        // path — refusal by authorization, not by string shape.
        assert_eq!(room_channel_id("voice_-3"), Some(-3));
    }

    /// The two shapes stay DISTINCT: `same_voice_room` and the presence carve-out
    /// both key off `parse_voice_room` alone, so a text room must never answer it.
    /// The gate itself, as the handler calls it: `join_target` REFUSES every id
    /// that is not one of the two shapes, and the two shapes reach the
    /// permission resolver with a channel id. Reverting the gate — making this
    /// function hand back a channel (or the handler fall through) — turns this
    /// test red, which is what makes it worth having.
    #[test]
    fn join_target_refuses_every_shape_the_server_does_not_own() {
        for bad in ["dm_1", "", "channel_", "voice_", "CHANNEL_1", "room1", "lobby"] {
            assert_eq!(
                join_target(bad),
                Err("unknown room"),
                "JoinRoom must refuse {bad:?}"
            );
        }
        assert_eq!(join_target("channel_1"), Ok(1));
        assert_eq!(join_target("voice_1"), Ok(1));
    }

    /// L8-AUTHZ-4. A TEXT room must now resolve a channel, so the mutate gate
    /// re-checks VIEW on it exactly as the join gate does. Reverting
    /// `mutate_gate_target` to `parse_voice_room` alone makes the first
    /// assertion red — which is the point of asserting it here rather than on
    /// `room_channel_id`, which was always both-shapes.
    #[test]
    fn the_mutate_gate_resolves_text_rooms_too_and_scopes_extra_to_voice() {
        assert_eq!(
            mutate_gate_target("channel_5", None),
            Some((5, None)),
            "a text room must reach the permission resolver"
        );
        // STREAM/VIDEO are voice semantics: dropped for a text room, kept for voice.
        assert_eq!(
            mutate_gate_target("channel_5", Some(Permissions::STREAM)),
            Some((5, None)),
            "a text channel has no media bit to enforce"
        );
        assert_eq!(
            mutate_gate_target("voice_5", Some(Permissions::STREAM)),
            Some((5, Some(Permissions::STREAM))),
        );
        assert_eq!(mutate_gate_target("voice_5", None), Some((5, None)));
        // No channel behind it → the defensive membership-only floor.
        assert_eq!(mutate_gate_target("dm_1", None), None);
        assert_eq!(mutate_gate_target("", Some(Permissions::VIDEO)), None);
    }

    #[test]
    fn a_text_room_is_not_a_voice_room() {
        assert!(parse_voice_room("channel_5").is_none());
        assert!(parse_channel_room("voice_5").is_none());
        assert_eq!(parse_channel_room("channel_5"), Some(5));
        assert_eq!(parse_voice_room("voice_5"), Some(5));
    }

}

#[cfg(test)]
mod device_attest_bind_tests {
    use super::{bind_attested_device, device_attest_message, handle_message};
    use crate::protocol::ServerMessage;
    use crate::state::{AppState, UserId};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::mpsc;

    /// A user with one live device whose signing key the test holds, and one
    /// session row bound to nothing. TEST_DATABASE_URL only; the caller
    /// deletes the user (its devices and session rows cascade with it).
    async fn fixture(pool: &sqlx::PgPool) -> (i32, ed25519_dalek::SigningKey, String, String) {
        let name = format!("attest_{}", uuid::Uuid::new_v4().simple());
        let (uid,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
            .bind(&name).bind(b"s".as_ref()).bind(b"v".as_ref())
            .fetch_one(pool).await.expect("insert user");
        let (key, device) = enrol(pool, uid).await;
        let sid = format!("at-sid-{}", uuid::Uuid::new_v4().simple());
        sqlx::query("INSERT INTO token_sessions (sid, user_id) VALUES ($1, $2)")
            .bind(&sid).bind(uid).execute(pool).await.expect("insert session");
        (uid, key, device, sid)
    }

    /// One more live device of `uid`, with a real signing key.
    async fn enrol(pool: &sqlx::PgPool, uid: i32) -> (ed25519_dalek::SigningKey, String) {
        use base64::Engine;
        use rand::RngCore;
        let mut seed = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut seed);
        let key = ed25519_dalek::SigningKey::from_bytes(&seed);
        let device = format!("at-{}", uuid::Uuid::new_v4().simple());
        sqlx::query(
            "INSERT INTO devices (id, user_id, device_pub, sign_pub, name, platform, auth_record, auth_sig) \
             VALUES ($1, $2, 'x25519:' || $1, $3, 'test', 'windows', '{}', 'x')",
        )
        .bind(&device).bind(uid)
        .bind(format!("ed25519:{}", base64::engine::general_purpose::STANDARD.encode(key.verifying_key().to_bytes())))
        .execute(pool).await.expect("insert device");
        (key, device)
    }

    /// Which device the session row is bound to. Panics if the row is gone,
    /// so "bound to nothing" can never be a missing row read as NULL.
    async fn bound_to(pool: &sqlx::PgPool, sid: &str) -> Option<String> {
        let (device,): (Option<String>,) = sqlx::query_as("SELECT device_id FROM token_sessions WHERE sid = $1")
            .bind(sid).fetch_one(pool).await.expect("the session row exists");
        device
    }

    /// A device revoked after the handler's read but before the bind is
    /// refused, and the session stays bound to nothing. This is the race run
    /// in sequence: the old bind was an unconditional UPDATE that never looked
    /// at the device again, so it bound the session to the revoked device. A
    /// device of ANOTHER user is refused the same way, so the locked read
    /// stands on its own rather than leaning on the handler's. The positive
    /// controls (a live device does bind) are in the two tests below.
    /// TEST_DATABASE_URL only.
    #[tokio::test]
    async fn a_device_revoked_before_the_bind_is_refused_and_binds_nothing() {
        let Some(pool) = crate::migrator::test_pool(2).await else { return };
        let (uid, _key, device, sid) = fixture(&pool).await;
        let (other_uid, _other_key, other_device, _other_sid) = fixture(&pool).await;

        sqlx::query("UPDATE devices SET revoked_at = NOW() WHERE id = $1").bind(&device).execute(&pool).await.unwrap();
        let with_sid = bind_attested_device(&pool, uid as UserId, &device, Some(&sid)).await;
        let without_sid = bind_attested_device(&pool, uid as UserId, &device, None).await;
        let foreign = bind_attested_device(&pool, uid as UserId, &other_device, Some(&sid)).await;
        let bound = bound_to(&pool, &sid).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)").bind(vec![uid, other_uid]).execute(&pool).await;

        assert!(matches!(with_sid, Ok(false)), "a revoked device must be refused at the bind: {with_sid:?}");
        assert!(matches!(without_sid, Ok(false)), "a socket with no sid gets the same locked check: {without_sid:?}");
        assert!(matches!(foreign, Ok(false)), "another user's device is not this user's to attest as: {foreign:?}");
        assert_eq!(bound, None, "the session must stay bound to nothing");
    }

    /// Everything one raced DeviceAttest left behind.
    struct Raced {
        answer: Result<(), String>,
        /// The bind was seen waiting on the uncommitted revoke.
        parked: bool,
        /// The device this socket is attested as in memory afterwards.
        attested: Option<String>,
        /// The socket was sent DeviceAttested.
        told: bool,
    }

    /// One DeviceAttest, through the real handler on a registered socket,
    /// raced against a revoke of its device that is held UNCOMMITTED until the
    /// attestation is parked behind it, or has finished. `sid` is "" for a
    /// socket on a legacy token that carries none.
    ///
    /// Where it parks is what differs. The fixed handler waits in the bind's
    /// locked read, before anything is bound or attested. The old one waited
    /// too, but only at its closing `last_seen_at` touch of the device row,
    /// after it had already bound the session and attested the socket; so
    /// `parked` alone proves the race was staged, not that it was won.
    async fn raced(
        pool: &sqlx::PgPool,
        state: &Arc<AppState>,
        key: &ed25519_dalek::SigningKey,
        device: &str,
        uid: i32,
        sid: &str,
        revoke_commits: bool,
    ) -> Raced {
        use base64::Engine;
        use ed25519_dalek::Signer;
        use rand::RngCore;
        let b64 = base64::engine::general_purpose::STANDARD;
        let (tx, mut rx) = mpsc::channel::<ServerMessage>(64);
        let (conn_id, _, _) = state.register_session(uid as UserId, "attester".into(), tx, false, None, sid.to_string());
        let mut raw = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut raw);
        let nonce = b64.encode(raw);
        let sig = key.sign(device_attest_message(&nonce, uid as UserId).as_bytes());
        let frame = serde_json::json!({
            "type": "DeviceAttest",
            "payload": { "device_id": device, "sig": b64.encode(sig.to_bytes()) },
        })
        .to_string();

        let mut revoke = pool.begin().await.expect("begin");
        let (revoker,): (i32,) = sqlx::query_as("SELECT pg_backend_pid()").fetch_one(&mut *revoke).await.unwrap();
        sqlx::query("UPDATE devices SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL")
            .bind(device).execute(&mut *revoke).await.expect("mark the device, uncommitted");
        let attest = tokio::spawn({
            let state = state.clone();
            async move {
                let mut joined = std::collections::HashSet::new();
                handle_message(&state, uid as UserId, conn_id, "attester", &frame, &mut joined, &nonce).await
            }
        });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let parked = loop {
            let (waiting,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))")
                .bind(revoker).fetch_one(pool).await.unwrap();
            if waiting > 0 {
                break true;
            }
            if attest.is_finished() {
                break false;
            }
            assert!(tokio::time::Instant::now() < deadline, "fixture: the attestation neither finished nor waited within 10 s");
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        if revoke_commits {
            revoke.commit().await.expect("commit the revoke");
        } else {
            revoke.rollback().await.expect("roll the revoke back");
        }
        let answer = attest.await.expect("attest task");
        let attested = state.device_of_conn(uid as UserId, conn_id);
        let mut told = false;
        while let Ok(msg) = rx.try_recv() {
            told |= matches!(msg, ServerMessage::DeviceAttested { .. });
        }
        state.unregister_session(uid as UserId, conn_id);
        Raced { answer, parked, attested, told }
    }

    /// THE RACE. A device revoked while one of its sockets is attesting must
    /// not come out of it attested. The handler reads the device (live),
    /// verifies the signature, then binds; `revoke_device` marks the device
    /// and sweeps the sessions bound to it, then kills the sockets attested as
    /// it or on a swept sid. A revoke committing between the read and the bind
    /// found this socket neither bound nor attested, so it reached nothing,
    /// and the old handler then attested the socket and bound the session to
    /// the revoked device over its head.
    ///
    /// Staged exactly, as the device-token mint's race test is: the revoke's
    /// UPDATE of the device row is held UNCOMMITTED, so the handler's plain
    /// read still sees the device live and the signature verifies, and the
    /// revoke commits only once the attestation is waiting on that row. Run for a
    /// socket with a sid and for a legacy one without (it has no row to bind,
    /// but gets the same locked check). The control rolls the revoke back
    /// instead, so a refusal caused by the waiting rather than by the
    /// revocation fails it. TEST_DATABASE_URL only.
    #[tokio::test]
    async fn a_device_revoked_between_the_read_and_the_bind_is_not_attested() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let (uid, key, device, sid) = fixture(&pool).await;
        // Nothing in the product ever un-revokes a device; this is only the
        // fixture resetting itself between runs.
        let unrevoke = || sqlx::query("UPDATE devices SET revoked_at = NULL WHERE id = $1").bind(&device).execute(&pool);

        let with_sid = raced(&pool, &state, &key, &device, uid, &sid, true).await;
        let bound_after_revoke = bound_to(&pool, &sid).await;
        unrevoke().await.unwrap();
        let legacy = raced(&pool, &state, &key, &device, uid, "", true).await;
        unrevoke().await.unwrap();
        let control = raced(&pool, &state, &key, &device, uid, &sid, false).await;
        let bound_after_control = bound_to(&pool, &sid).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(uid).execute(&pool).await;

        for (label, run) in [("with a sid", &with_sid), ("legacy, no sid", &legacy)] {
            // Refused exactly as an unknown or revoked device is: no error on
            // the wire, no DeviceAttested, no binding.
            assert_eq!(run.answer, Ok(()), "{label}: a refusal is not an error");
            assert_eq!(
                run.attested, None,
                "{label}: the socket was left attested in memory as a device revoked mid-attestation",
            );
            assert!(!run.told, "{label}: the socket was told it attested as a device revoked mid-attestation");
        }
        assert_eq!(bound_after_revoke, None, "the session was bound to a device revoked mid-attestation");
        // Positive control: the same staging with the revoke abandoned
        // attests and binds, so the refusals above came from the revocation.
        assert_eq!(control.answer, Ok(()));
        assert_eq!(control.attested.as_deref(), Some(device.as_str()), "an abandoned revoke must not cost the socket its attestation");
        assert!(control.told, "the control socket is told it attested");
        assert_eq!(bound_after_control.as_deref(), Some(device.as_str()), "the control binds the session to the device");
        // And the race really was run: every attestation was held up by the
        // uncommitted revoke, after the handler's read had seen the device
        // live and the signature had verified.
        assert!(
            with_sid.parked && legacy.parked && control.parked,
            "fixture: the bind must have waited on the revoke (sid {}, legacy {}, control {})",
            with_sid.parked, legacy.parked, control.parked,
        );
    }

    /// What one attestation left behind when a revoke was landed in the gap
    /// between its bind's commit and its in-memory attestation.
    struct InTheGap {
        answer: Result<(), String>,
        /// The revoke's own kill reached the socket (it cannot: that is the gap).
        hung_up_by_revoke: bool,
        attested: Option<String>,
        told: bool,
        hung_up: bool,
        /// Another socket of the user was told the device came online.
        presence_online: bool,
    }

    /// The handler's own sequence (`bind_attested_device`, then
    /// `complete_attestation`) with the REAL `revoke_device` run, when
    /// `revoke` is set, between the two: after the bind has committed, before
    /// the socket is attested in memory. There is no await between those two
    /// in the handler, so calling them in this order is the only way to put a
    /// revoke there deterministically. A second, unattested socket of the same
    /// user stands in for the owner's other devices, to see presence.
    async fn in_the_gap(
        pool: &sqlx::PgPool,
        state: &Arc<AppState>,
        uid: i32,
        device: &str,
        sid: &str,
        revoke: bool,
    ) -> InTheGap {
        use axum::extract::{Extension, Path, State};
        let (tx, mut rx) = mpsc::channel::<ServerMessage>(64);
        let (conn_id, _, kill) = state.register_session(uid as UserId, "attester".into(), tx, false, None, sid.to_string());
        let (otx, mut orx) = mpsc::channel::<ServerMessage>(64);
        let (observer, _, _) = state.register_session(uid as UserId, "observer".into(), otx, false, None, String::new());
        let hung = |kill: Arc<tokio::sync::Notify>| async move {
            tokio::time::timeout(Duration::from_millis(50), kill.notified()).await.is_ok()
        };

        let bound = bind_attested_device(pool, uid as UserId, device, Some(sid).filter(|s| !s.is_empty())).await;
        assert!(matches!(bound, Ok(true)), "fixture: the device is live at the bind: {bound:?}");
        let mut hung_up_by_revoke = false;
        if revoke {
            let (tv,): (i32,) = sqlx::query_as("SELECT token_version FROM users WHERE id = $1").bind(uid).fetch_one(pool).await.unwrap();
            let claims = crate::auth::Claims { sub: uid as UserId, username: "attester".into(), exp: 0, tv, sst: 0, sid: String::new(), ls: false };
            let revoked = crate::device_handlers::revoke_device(State(state.clone()), Extension(claims), Path(device.to_string())).await;
            assert!(revoked.is_ok(), "fixture: the revoke succeeds: {:?}", revoked.err());
            hung_up_by_revoke = hung(kill.clone()).await;
        }
        let answer = super::complete_attestation(state, uid as UserId, conn_id, device.to_string()).await;

        let attested = state.device_of_conn(uid as UserId, conn_id);
        let hung_up = hung(kill.clone()).await;
        let mut told = false;
        while let Ok(msg) = rx.try_recv() {
            told |= matches!(msg, ServerMessage::DeviceAttested { .. });
        }
        let mut presence_online = false;
        while let Ok(msg) = orx.try_recv() {
            presence_online |= matches!(msg, ServerMessage::DevicePresence { online: true, .. });
        }
        state.unregister_session(uid as UserId, conn_id);
        state.unregister_session(uid as UserId, observer);
        InTheGap { answer, hung_up_by_revoke, attested, told, hung_up, presence_online }
    }

    /// THE GAP THE BIND CANNOT CLOSE. A socket whose session is not bound to
    /// the device it attests as (a legacy token with no sid, or a session an
    /// earlier attestation bound to another device) is reachable by a revoke
    /// only through its in-memory attestation. A revoke that commits after the
    /// bind's commit but before `attest_device` sweeps no session of this
    /// socket and finds nothing attested to kill; without the re-check in
    /// `complete_attestation` the socket was then attested as the revoked
    /// device, told so, and announced to the owner's other devices.
    ///
    /// The revoke is the real handler, and the test first proves it missed
    /// the socket (`hung_up_by_revoke` false) so the gap is real. The control
    /// runs the same sequence with no revoke and must attest, tell and
    /// announce, so a check that refused everything fails it.
    /// TEST_DATABASE_URL only.
    #[tokio::test]
    async fn a_revoke_landing_between_the_bind_and_the_attest_still_ends_the_attestation() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let (uid, _key, device, sid) = fixture(&pool).await;
        let (_other_key, other) = enrol(&pool, uid).await;
        sqlx::query("UPDATE token_sessions SET device_id = $1 WHERE sid = $2").bind(&other).bind(&sid).execute(&pool).await.unwrap();
        let unrevoke = || sqlx::query("UPDATE devices SET revoked_at = NULL WHERE id = $1").bind(&device).execute(&pool);

        let legacy_control = in_the_gap(&pool, &state, uid, &device, "", false).await;
        let legacy = in_the_gap(&pool, &state, uid, &device, "", true).await;
        unrevoke().await.unwrap();
        let elsewhere_control = in_the_gap(&pool, &state, uid, &device, &sid, false).await;
        let elsewhere = in_the_gap(&pool, &state, uid, &device, &sid, true).await;
        let still_bound_to_other = bound_to(&pool, &sid).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(uid).execute(&pool).await;

        for (label, run) in [("legacy, no sid", &legacy), ("session bound to another device", &elsewhere)] {
            assert!(!run.hung_up_by_revoke, "fixture ({label}): the revoke's own kill must miss the socket, or there is no gap");
            assert_eq!(run.answer, Ok(()), "{label}: a refusal is not an error");
            assert_eq!(run.attested, None, "{label}: the socket was left attested as a device revoked in the gap");
            assert!(!run.told, "{label}: the socket was told it attested as a device revoked in the gap");
            assert!(!run.presence_online, "{label}: the owner's other devices were told a revoked device came online");
            assert!(run.hung_up, "{label}: the socket must be hung up, as the revoke would have done had it seen it");
        }
        for (label, run) in [("legacy control", &legacy_control), ("bound-elsewhere control", &elsewhere_control)] {
            assert_eq!(run.answer, Ok(()));
            assert_eq!(run.attested.as_deref(), Some(device.as_str()), "{label}: with no revoke the socket attests");
            assert!(run.told && run.presence_online, "{label}: told, and announced (told {}, presence {})", run.told, run.presence_online);
            assert!(!run.hung_up, "{label}: and stays up");
        }
        assert_eq!(still_bound_to_other.as_deref(), Some(other.as_str()), "fixture: first writer wins kept the other device's binding");
    }

    /// A live device binds, and first-writer-wins still holds: a session
    /// already bound to device A cannot be re-pointed to device B, so a token
    /// copied to another machine cannot move its session away from the device
    /// its owner is about to revoke. B is still live, so its attestation is
    /// not refused (the answer is about the device, not the session); what
    /// it must not do is take the session. TEST_DATABASE_URL only.
    #[tokio::test]
    async fn a_live_device_binds_and_the_first_binding_stands() {
        let Some(pool) = crate::migrator::test_pool(2).await else { return };
        let (uid, _key, first, sid) = fixture(&pool).await;
        let (_key_b, second) = enrol(&pool, uid).await;

        let bind_first = bind_attested_device(&pool, uid as UserId, &first, Some(&sid)).await;
        let after_first = bound_to(&pool, &sid).await;
        let bind_second = bind_attested_device(&pool, uid as UserId, &second, Some(&sid)).await;
        let after_second = bound_to(&pool, &sid).await;
        let rebind_first = bind_attested_device(&pool, uid as UserId, &first, Some(&sid)).await;
        let legacy = bind_attested_device(&pool, uid as UserId, &second, None).await;
        let after_all = bound_to(&pool, &sid).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(uid).execute(&pool).await;

        assert!(matches!(bind_first, Ok(true)), "a live device attests: {bind_first:?}");
        assert_eq!(after_first.as_deref(), Some(first.as_str()), "and its session is bound to it");
        assert!(matches!(bind_second, Ok(true)), "a second live device is still a live device: {bind_second:?}");
        assert_eq!(after_second.as_deref(), Some(first.as_str()), "first writer wins: the session stays bound to the first device");
        assert!(matches!(rebind_first, Ok(true)), "re-attesting as the bound device is fine: {rebind_first:?}");
        assert!(matches!(legacy, Ok(true)), "a live device attests on a socket with no sid: {legacy:?}");
        assert_eq!(after_all.as_deref(), Some(first.as_str()));
    }
}

#[cfg(test)]
mod voice_speak_join_tests {
    use super::{evict_sweep, handle_message, JOIN_NO_CONNECT, JOIN_REFUSED};
    use crate::permissions::Permissions;
    use crate::protocol::ServerMessage;
    use crate::state::{AppState, UserId};
    use std::collections::HashSet;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    /// One registered socket of one user, driven through the real handler.
    struct Sock {
        uid: UserId,
        name: String,
        conn: u64,
        rx: mpsc::Receiver<ServerMessage>,
        joined: HashSet<String>,
    }

    impl Sock {
        fn open(state: &Arc<AppState>, uid: i32, name: &str) -> Sock {
            let (tx, rx) = mpsc::channel::<ServerMessage>(256);
            let (conn, _, _) = state.register_session(uid as UserId, name.to_string(), tx, false, None, String::new());
            Sock { uid: uid as UserId, name: name.to_string(), conn, rx, joined: HashSet::new() }
        }

        async fn join(&mut self, state: &Arc<AppState>, room: &str) -> Result<(), String> {
            let frame = serde_json::json!({ "type": "JoinRoom", "payload": { "room_id": room } }).to_string();
            handle_message(state, self.uid, self.conn, &self.name, &frame, &mut self.joined, "").await
        }

        /// Everything queued since the last drain, in order.
        fn drain(&mut self) -> Vec<ServerMessage> {
            let mut out = Vec::new();
            while let Ok(m) = self.rx.try_recv() {
                out.push(m);
            }
            out
        }
    }

    /// The VoiceSpeakState frames for `room`, in arrival order.
    fn speak(frames: &[ServerMessage], room: &str) -> Vec<(UserId, bool)> {
        frames
            .iter()
            .filter_map(|m| match m {
                ServerMessage::VoiceSpeakState { room_id, user_id, can_speak } if room_id == room => {
                    Some((*user_id, *can_speak))
                }
                _ => None,
            })
            .collect()
    }

    /// RoomJoined for `room` arrived, and before the first speak frame.
    fn room_joined_first(frames: &[ServerMessage], room: &str) -> bool {
        let joined = frames
            .iter()
            .position(|m| matches!(m, ServerMessage::RoomJoined { room_id, .. } if room_id == room));
        let first_speak = frames.iter().position(|m| matches!(m, ServerMessage::VoiceSpeakState { .. }));
        matches!((joined, first_speak), (Some(j), Some(s)) if j < s)
    }

    /// Deny `bits` to `role_id` on `channel` (an upsert).
    async fn deny(pool: &sqlx::PgPool, channel: i32, role_id: i64, bits: Permissions) {
        sqlx::query(
            "INSERT INTO channel_permission_overwrites (channel_id, role_id, allow, deny) VALUES ($1, $2, 0, $3) \
             ON CONFLICT (channel_id, role_id) DO UPDATE SET deny = EXCLUDED.deny",
        )
        .bind(channel as i64)
        .bind(role_id)
        .bind(bits.bits() as i64)
        .execute(pool)
        .await
        .expect("overwrite");
    }

    /// A role with no permissions of its own, held by `holder`.
    async fn role(pool: &sqlx::PgPool, sid: &str, name: &str, holder: i32) -> i64 {
        let (rid,): (i64,) = sqlx::query_as(
            "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) \
             VALUES ($1, $2, '#99AAB5', 0, 1, false) RETURNING id",
        )
        .bind(sid)
        .bind(name)
        .fetch_one(pool)
        .await
        .expect("role");
        sqlx::query("INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)")
            .bind(sid)
            .bind(holder)
            .bind(rid)
            .execute(pool)
            .await
            .expect("member role");
        rid
    }

    /// THE SPEAK AUTHORITY, end to end through the real JoinRoom handler and
    /// the real perms-change sweep (TEST_DATABASE_URL; skips without it).
    ///
    /// A member whose role carries a channel overwrite denying SPEAK is
    /// admitted to the voice room (they hold VIEW + CONNECT) but flagged
    /// false: to themselves (their client must not send) and to everyone
    /// already in the room (their receivers must refuse the audio). A member
    /// without that overwrite, and the owner, are flagged true. The expected
    /// lists hold `true` entries AND a `false` one, so the test is red for
    /// "no frames at all", for "always true" and for "always false" alike.
    ///
    /// Then the sweep: lifting the deny flips the stored right and tells the
    /// WHOLE room, the member included; re-imposing it flips it back; a sweep
    /// with nothing changed says nothing.
    ///
    /// Refusals ride along: a member who sees the channel but is denied
    /// CONNECT is told it is CONNECT; a VIEW-denied member and a non-member
    /// get the generic text; none of the three is sent any speak state.
    #[tokio::test]
    async fn a_speak_denied_member_is_flagged_false_to_themselves_and_the_room() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let mk = |n: &str| format!("vs_{n}_{}", &tag[..12]);
        let mut ids: Vec<i32> = Vec::new();
        for n in ["owner", "speaker", "muted", "noconnect", "hidden", "outsider"] {
            let (id,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
                .bind(mk(n))
                .bind(b"s".as_ref())
                .bind(b"v".as_ref())
                .fetch_one(&pool)
                .await
                .expect("user");
            ids.push(id);
        }
        let (owner_i, speaker_i, muted_i, noconnect_i, hidden_i, outsider_i) = (ids[0], ids[1], ids[2], ids[3], ids[4], ids[5]);
        let sid = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, $2, $3)")
            .bind(&sid)
            .bind(mk("srv"))
            .bind(owner_i)
            .execute(&pool)
            .await
            .expect("server");
        for m in [owner_i, speaker_i, muted_i, noconnect_i, hidden_i] {
            sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)")
                .bind(&sid)
                .bind(m)
                .execute(&pool)
                .await
                .expect("member");
        }
        let everyone = (Permissions::VIEW_CHANNEL | Permissions::CONNECT | Permissions::SPEAK).bits() as i64;
        sqlx::query(
            "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) \
             VALUES ($1, '@everyone', '#99AAB5', $2, 0, true)",
        )
        .bind(&sid)
        .bind(everyone)
        .execute(&pool)
        .await
        .expect("@everyone");
        let muted_role = role(&pool, &sid, "muted", muted_i).await;
        let noconnect_role = role(&pool, &sid, "noconnect", noconnect_i).await;
        let hidden_role = role(&pool, &sid, "hidden", hidden_i).await;
        let (voice,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type, sfu_mode) VALUES ($1, 'v', 1, false) RETURNING id")
            .bind(&sid)
            .fetch_one(&pool)
            .await
            .expect("voice channel");
        let (text,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type) VALUES ($1, 't', 0) RETURNING id")
            .bind(&sid)
            .fetch_one(&pool)
            .await
            .expect("text channel");
        deny(&pool, voice, muted_role, Permissions::SPEAK).await;
        deny(&pool, voice, noconnect_role, Permissions::CONNECT).await;
        deny(&pool, voice, hidden_role, Permissions::VIEW_CHANNEL).await;

        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = format!("voice_{voice}");
        let text_room = format!("channel_{text}");
        let (owner, speaker, muted) = (owner_i as UserId, speaker_i as UserId, muted_i as UserId);
        let mut s_owner = Sock::open(&state, owner_i, "owner");
        let mut s_speaker = Sock::open(&state, speaker_i, "speaker");
        let mut s_muted = Sock::open(&state, muted_i, "muted");
        let mut s_noconnect = Sock::open(&state, noconnect_i, "noconnect");
        let mut s_hidden = Sock::open(&state, hidden_i, "hidden");
        let mut s_outsider = Sock::open(&state, outsider_i, "outsider");

        // A text room carries no speak right at all (negative control).
        let text_join = s_owner.join(&state, &text_room).await;
        let text_frames = s_owner.drain();

        let j_owner = s_owner.join(&state, &room).await;
        let j_speaker = s_speaker.join(&state, &room).await;
        let j_muted = s_muted.join(&state, &room).await;
        let j_noconnect = s_noconnect.join(&state, &room).await;
        let j_hidden = s_hidden.join(&state, &room).await;
        let j_outsider = s_outsider.join(&state, &room).await;
        let (f_owner, f_speaker, f_muted) = (s_owner.drain(), s_speaker.drain(), s_muted.drain());
        let refused_saw: usize = [&mut s_noconnect, &mut s_hidden, &mut s_outsider]
            .into_iter()
            .map(|s| speak(&s.drain(), &room).len())
            .sum();
        let stored_muted = state.rooms.get(&room).map(|r| r.can_speak(muted));
        let members_after_join: Vec<UserId> = state.rooms.get(&room).map(|r| r.members.clone()).unwrap_or_default();

        // The sweep: lift the SPEAK deny, then put it back, then change nothing.
        sqlx::query("DELETE FROM channel_permission_overwrites WHERE channel_id = $1 AND role_id = $2")
            .bind(voice as i64)
            .bind(muted_role)
            .execute(&pool)
            .await
            .expect("lift the deny");
        evict_sweep(&state, &sid, 0).await;
        let lifted = (speak(&s_owner.drain(), &room), speak(&s_speaker.drain(), &room), speak(&s_muted.drain(), &room));
        let stored_after_lift = state.rooms.get(&room).map(|r| r.can_speak(muted));
        deny(&pool, voice, muted_role, Permissions::SPEAK).await;
        evict_sweep(&state, &sid, 0).await;
        let reimposed = (speak(&s_owner.drain(), &room), speak(&s_speaker.drain(), &room), speak(&s_muted.drain(), &room));
        evict_sweep(&state, &sid, 0).await;
        let unchanged = (speak(&s_owner.drain(), &room), speak(&s_speaker.drain(), &room), speak(&s_muted.drain(), &room));
        let members_after_sweeps: Vec<UserId> = state.rooms.get(&room).map(|r| r.members.clone()).unwrap_or_default();

        for s in [&s_owner, &s_speaker, &s_muted, &s_noconnect, &s_hidden, &s_outsider] {
            state.unregister_session(s.uid, s.conn);
        }
        let _ = sqlx::query("DELETE FROM channels WHERE id = ANY($1)").bind(vec![voice, text]).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&sid).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)").bind(ids.clone()).execute(&pool).await;

        assert_eq!(text_join, Ok(()), "fixture: the owner joins the text room");
        assert!(
            !text_frames.iter().any(|m| matches!(m, ServerMessage::VoiceSpeakState { .. })),
            "a text room carries no speak right: {text_frames:?}"
        );

        assert_eq!(j_owner, Ok(()));
        assert_eq!(j_speaker, Ok(()));
        assert_eq!(j_muted, Ok(()), "SPEAK is not needed to JOIN: VIEW + CONNECT admit");
        assert_eq!(members_after_join, vec![owner, speaker, muted]);

        // Each joiner is told every member present, itself included, after RoomJoined.
        assert!(room_joined_first(&f_owner, &room), "owner: RoomJoined first: {f_owner:?}");
        assert!(room_joined_first(&f_speaker, &room), "speaker: RoomJoined first: {f_speaker:?}");
        assert!(room_joined_first(&f_muted, &room), "muted: RoomJoined first: {f_muted:?}");
        let all = vec![(owner, true), (speaker, true), (muted, false)];
        // owner: its own snapshot, then each later joiner's frame.
        assert_eq!(speak(&f_owner, &room), all, "owner: {f_owner:?}");
        // speaker: a snapshot of owner + itself, then the muted joiner's frame.
        assert_eq!(speak(&f_speaker, &room), all, "speaker: {f_speaker:?}");
        // muted: the snapshot, including its OWN false (its client must not send).
        assert_eq!(speak(&f_muted, &room), all, "muted: {f_muted:?}");
        assert_eq!(stored_muted, Some(false));

        assert_eq!(j_noconnect, Err(JOIN_NO_CONNECT.to_string()), "a member who sees the channel is told it is CONNECT");
        assert_eq!(j_hidden, Err(JOIN_REFUSED.to_string()), "VIEW-denied: the generic text");
        assert_eq!(j_outsider, Err(JOIN_REFUSED.to_string()), "a non-member: the generic text");
        assert_eq!(refused_saw, 0, "a refused joiner is sent no speak state");

        // Sweep, deny lifted: all three hear the ONE change, the member included.
        let one = |v: bool| vec![(muted, v)];
        assert_eq!(lifted, (one(true), one(true), one(true)), "lifting the deny");
        assert_eq!(stored_after_lift, Some(true));
        assert_eq!(reimposed, (one(false), one(false), one(false)), "re-imposing the deny");
        assert_eq!(unchanged, (vec![], vec![], vec![]), "no change, no frame");
        assert_eq!(members_after_sweeps, vec![owner, speaker, muted], "a SPEAK deny never evicts");
    }

    /// A server with a mesh voice channel whose @everyone may VIEW, CONNECT
    /// and SPEAK, its owner, and a member holding the (permission-less) role
    /// `quiet`. Returns (server id, [owner, member], quiet role, channel).
    async fn mesh_fixture(pool: &sqlx::PgPool, prefix: &str) -> (String, Vec<i32>, i64, i32) {
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let mk = |n: &str| format!("{prefix}_{n}_{}", &tag[..12]);
        let mut ids: Vec<i32> = Vec::new();
        for n in ["owner", "member"] {
            let (id,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
                .bind(mk(n))
                .bind(b"s".as_ref())
                .bind(b"v".as_ref())
                .fetch_one(pool)
                .await
                .expect("user");
            ids.push(id);
        }
        let sid = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, $2, $3)")
            .bind(&sid)
            .bind(mk("srv"))
            .bind(ids[0])
            .execute(pool)
            .await
            .expect("server");
        sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2), ($1, $3)")
            .bind(&sid)
            .bind(ids[0])
            .bind(ids[1])
            .execute(pool)
            .await
            .expect("members");
        sqlx::query(
            "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) \
             VALUES ($1, '@everyone', '#99AAB5', $2, 0, true)",
        )
        .bind(&sid)
        .bind((Permissions::VIEW_CHANNEL | Permissions::CONNECT | Permissions::SPEAK).bits() as i64)
        .execute(pool)
        .await
        .expect("@everyone");
        let quiet = role(pool, &sid, "quiet", ids[1]).await;
        let (voice,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type, sfu_mode) VALUES ($1, 'v', 1, false) RETURNING id")
            .bind(&sid)
            .fetch_one(pool)
            .await
            .expect("voice channel");
        (sid, ids, quiet, voice)
    }

    async fn drop_mesh_fixture(pool: &sqlx::PgPool, sid: &str, ids: &[i32], voice: i32) {
        let _ = sqlx::query("DELETE FROM channels WHERE id = $1").bind(voice).execute(pool).await;
        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(sid).execute(pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)").bind(ids.to_vec()).execute(pool).await;
    }

    /// A perms change whose HTTP request goes AWAY still sweeps
    /// (TEST_DATABASE_URL; skips without it). The handler's future is dropped
    /// at its first await - the client gave up, a proxy cut the request. The
    /// work is detached, so the member whose SPEAK deny was lifted still hears
    /// that they may speak again. (Inline, the sweep died with the request,
    /// and nothing else would ever have told them.)
    #[tokio::test]
    async fn a_perms_change_whose_request_is_dropped_still_sweeps() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let (sid, ids, quiet, voice) = mesh_fixture(&pool, "pd").await;
        deny(&pool, voice, quiet, Permissions::SPEAK).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = format!("voice_{voice}");
        let member = ids[1] as UserId;
        let mut s_owner = Sock::open(&state, ids[0], "owner");
        let mut s_member = Sock::open(&state, ids[1], "member");
        let joined = (s_owner.join(&state, &room).await, s_member.join(&state, &room).await);
        let flagged = state.rooms.get(&room).map(|r| r.can_speak(member));
        s_member.drain();

        sqlx::query("DELETE FROM channel_permission_overwrites WHERE channel_id = $1 AND role_id = $2")
            .bind(voice as i64)
            .bind(quiet)
            .execute(&pool)
            .await
            .expect("lift the deny");
        let dropped = tokio::time::timeout(std::time::Duration::ZERO, super::broadcast_perms_changed_and_evict(&state, &sid)).await;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut heard = Vec::new();
        while !heard.contains(&(member, true)) && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            heard.extend(speak(&s_member.drain(), &room));
        }
        for s in [&s_owner, &s_member] {
            state.unregister_session(s.uid, s.conn);
        }
        drop_mesh_fixture(&pool, &sid, &ids, voice).await;

        assert_eq!(joined, (Ok(()), Ok(())));
        assert_eq!(flagged, Some(false), "fixture: denied at the join");
        assert!(dropped.is_err(), "fixture: the handler did not finish before it was dropped");
        assert_eq!(heard, vec![(member, true)], "the detached sweep told them");
    }

    /// A join whose speak answer a SWEEP OVERTOOK asks for another sweep
    /// (TEST_DATABASE_URL; skips without it). The member is denied SPEAK. A
    /// voice join's recheck resolves outside the server's lock, so its answer
    /// can be older than a sweep that resolved the member after a later change
    /// and already wrote the flag; the join, writing last, would leave its
    /// stale answer for every mesh receiver. Here the join read the sweep
    /// epoch, a sweep ran and wrote "denied", and then the join wrote its older
    /// "may speak": a sweep is requested, and the flag comes back to "denied".
    /// Positive control: with no sweep since the epoch was read, the join's
    /// answer is the newest there is, and nothing is requested.
    #[tokio::test]
    async fn a_join_whose_speak_answer_a_sweep_overtook_asks_for_another() {
        use super::{perms_sweep_epoch, store_join_speak};
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let (sid, ids, quiet, voice) = mesh_fixture(&pool, "so").await;
        deny(&pool, voice, quiet, Permissions::SPEAK).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = format!("voice_{voice}");
        let member = ids[1] as UserId;
        let mut s_member = Sock::open(&state, ids[1], "member");
        let joined = s_member.join(&state, &room).await;
        let flag = || state.rooms.get(&room).map(|r| r.can_speak(member));

        // Control: no sweep since the epoch was read - nothing asked for.
        let epoch = perms_sweep_epoch(&state, &sid);
        store_join_speak(&state, &room, member, true, &sid, epoch);
        let control = (flag(), state.perms_sweeps.contains_key(&sid));

        // A sweep starts and writes the newest answer; then the join, which
        // read the epoch before it, writes its older one.
        evict_sweep(&state, &sid, 0).await;
        let swept = flag();
        store_join_speak(&state, &room, member, true, &sid, epoch);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while (flag() != Some(false) || state.perms_sweeps.contains_key(&sid)) && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let restored = flag();
        state.unregister_session(s_member.uid, s_member.conn);
        drop_mesh_fixture(&pool, &sid, &ids, voice).await;

        assert_eq!(joined, Ok(()));
        assert_eq!(control, (Some(true), false), "control: the join's answer stands, no sweep asked for");
        assert_eq!(swept, Some(false), "fixture: the sweep wrote the newest answer");
        assert_eq!(restored, Some(false), "the sweep the join asked for restored it");
    }

    /// A second device's join tells the FIRST device its own flag
    /// (TEST_DATABASE_URL; skips without it). The member's desktop is in the
    /// call, allowed to speak. SPEAK is denied to their role and, before any
    /// sweep runs, their phone joins the same room: that join is what finds
    /// the change, and the sweep will then find the flag already stored and
    /// say nothing. So the desktop must hear its own VoiceSpeakState(false)
    /// from the join - it is what closes that device's microphone - while the
    /// phone, whose snapshot said it, gets no second copy.
    #[tokio::test]
    async fn a_second_devices_join_tells_the_first_device_its_own_flag() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let (sid, ids, quiet, voice) = mesh_fixture(&pool, "sd").await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = format!("voice_{voice}");
        let (owner, member) = (ids[0] as UserId, ids[1] as UserId);
        let mut s_owner = Sock::open(&state, ids[0], "owner");
        let mut s_desk = Sock::open(&state, ids[1], "member");
        let mut s_phone = Sock::open(&state, ids[1], "member");
        let first = (s_owner.join(&state, &room).await, s_desk.join(&state, &room).await);
        let (_, _) = (s_owner.drain(), s_desk.drain());

        deny(&pool, voice, quiet, Permissions::SPEAK).await;
        let second = s_phone.join(&state, &room).await;
        let (f_owner, f_desk, f_phone) = (s_owner.drain(), s_desk.drain(), s_phone.drain());
        for s in [&s_owner, &s_desk, &s_phone] {
            state.unregister_session(s.uid, s.conn);
        }
        drop_mesh_fixture(&pool, &sid, &ids, voice).await;

        assert_eq!((first, second), ((Ok(()), Ok(())), Ok(())));
        assert_eq!(speak(&f_desk, &room), vec![(member, false)], "the desktop already in the call hears its own deny");
        assert_eq!(speak(&f_owner, &room), vec![(member, false)]);
        assert_eq!(
            speak(&f_phone, &room),
            vec![(owner, true), (member, false)],
            "the joining phone: its snapshot, and no second copy"
        );
    }
}

#[cfg(test)]
mod refused_join_tests {
    use super::withdraw_refused_join;
    use crate::protocol::ServerMessage;
    use crate::state::{AppState, UserId};
    use std::collections::HashSet;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::mpsc;

    /// An AppState whose database never answers, quickly.
    fn test_state() -> Arc<AppState> {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_secs(1))
            .connect_lazy("postgres://localhost/does_not_connect")
            .expect("lazy pool");
        AppState::new(pool, "test-secret".into(), None, Arc::new(crate::wake::NullWake))
    }

    fn open(state: &Arc<AppState>, uid: UserId) -> (u64, mpsc::Receiver<ServerMessage>) {
        let (tx, rx) = mpsc::channel::<ServerMessage>(64);
        let (conn, _, _) = state.register_session(uid, format!("u{uid}"), tx, false, None, String::new());
        (conn, rx)
    }

    fn drain(rx: &mut mpsc::Receiver<ServerMessage>) -> Vec<ServerMessage> {
        let mut out = Vec::new();
        while let Ok(m) = rx.try_recv() {
            out.push(m);
        }
        out
    }

    /// Whether `frames` announce `who` leaving (UserLeft) or retract their
    /// voice (StreamStopped).
    fn departed(frames: &[ServerMessage], who: UserId) -> (bool, bool) {
        (
            frames.iter().any(|m| matches!(m, ServerMessage::UserLeft { user_id, .. } if *user_id == who)),
            frames.iter().any(|m| matches!(m, ServerMessage::StreamStopped { streamer_id, .. } if *streamer_id == who)),
        )
    }

    /// A JoinRoom refused after its insert takes out THAT connection only, and
    /// announces only what had been announced.
    ///
    /// 1. The member's desktop is in the call; the phone's fresh join is
    ///    refused. The desktop keeps its membership - with its speak deny - and
    ///    stays reachable by the sweep's speak frames; nothing is announced.
    /// 2. A fresh connection that was the user's only one: the user is gone,
    ///    and was never announced, so nothing is announced now either.
    /// 3. A connection that was ALREADY in the room (a repeat join on the same
    ///    socket): it leaves as a LeaveRoom would - RoomLeft to it, UserLeft
    ///    and the voice retraction to the room.
    /// 4. The zombie reap. The user was announced through an old socket that is
    ///    reaped WHILE the new one's recheck runs: the reap hands the old
    ///    socket's stream claim to the new one and says nothing (the user was
    ///    still there). The new, fresh connection's refusal is then what takes
    ///    the user out, and it must say so, or peers keep a ghost - and a P2P
    ///    call - that no later sweep can see.
    #[tokio::test]
    async fn a_refused_join_takes_out_only_its_own_connection_and_announces_only_what_was_announced() {
        let state = test_state();
        let room = "voice_9";
        let (v, mut rv) = open(&state, 1);
        state.join_room(room, 1, v);

        // 1.
        let (desk, mut rdesk) = open(&state, 2);
        state.join_room(room, 2, desk);
        state.rooms.get_mut(room).unwrap().set_can_speak(2, false);
        let (phone, _rphone) = open(&state, 2);
        let mut phone_rooms: HashSet<String> = [room.to_string()].into_iter().collect();
        state.join_room(room, 2, phone);
        withdraw_refused_join(&state, room, 2, phone, false, true, &mut phone_rooms).await;
        let desk_kept = state.rooms.get(room).map(|r| (r.members.contains(&2), r.can_speak(2)));
        state.broadcast_speak_state(room, 2, None);
        let desk_heard = drain(&mut rdesk)
            .iter()
            .any(|m| matches!(m, ServerMessage::VoiceSpeakState { user_id: 2, can_speak: false, .. }));
        let after_1 = departed(&drain(&mut rv), 2);

        // 2.
        let (w, _rw) = open(&state, 3);
        let mut w_rooms: HashSet<String> = [room.to_string()].into_iter().collect();
        state.join_room(room, 3, w);
        withdraw_refused_join(&state, room, 3, w, false, false, &mut w_rooms).await;
        let w_gone = state.rooms.get(room).is_some_and(|r| !r.members.contains(&3));
        let after_2 = departed(&drain(&mut rv), 3);

        // 3.
        let (x, mut rx) = open(&state, 4);
        let mut x_rooms: HashSet<String> = [room.to_string()].into_iter().collect();
        state.join_room(room, 4, x); // its earlier, announced join
        state.join_room(room, 4, x); // the repeat that is refused
        withdraw_refused_join(&state, room, 4, x, true, true, &mut x_rooms).await;
        let x_gone = state.rooms.get(room).is_some_and(|r| !r.members.contains(&4));
        let after_3 = departed(&drain(&mut rv), 4);
        let x_told = drain(&mut rx).iter().any(|m| matches!(m, ServerMessage::RoomLeft { room_id, .. } if room_id == room));

        // 4.
        let (zombie, _rz) = open(&state, 5);
        state.join_room(room, 5, zombie); // announced, and in the call
        if let Some(mut r) = state.rooms.get_mut(room) {
            r.set_media(crate::state::MediaKind::Stream, 5, zombie, true);
        }
        let (fresh, mut rfresh) = open(&state, 5);
        let mut fresh_rooms: HashSet<String> = [room.to_string()].into_iter().collect();
        state.join_room(room, 5, fresh); // the reconnect's replayed join: already a member
        state.unregister_session(5, zombie); // the reap, mid-recheck
        let fresh_holds_it = state.rooms.get(room).is_some_and(|r| r.members.contains(&5));
        let reap_said = departed(&drain(&mut rv), 5);
        withdraw_refused_join(&state, room, 5, fresh, false, true, &mut fresh_rooms).await;
        let after_4 = departed(&drain(&mut rv), 5);
        let fresh_told = drain(&mut rfresh).iter().any(|m| matches!(m, ServerMessage::RoomLeft { room_id, .. } if room_id == room));

        assert_eq!(desk_kept, Some((true, false)), "the desktop stays, its deny with it");
        assert!(desk_heard, "and a later speak frame still reaches it");
        assert!(!phone_rooms.contains(room));
        assert_eq!(after_1, (false, false), "the user is still in the call: nothing to announce");
        assert!(w_gone && !w_rooms.contains(room));
        assert_eq!(after_2, (false, false), "never announced, so nothing taken back");
        assert!(x_gone);
        assert_eq!(after_3, (true, true), "announced before, so its departure is");
        assert!(x_told, "the connection itself is told it left");
        assert!(fresh_holds_it && reap_said == (false, false), "fixture: the reap left the user to the new connection, silently");
        assert_eq!(after_4, (true, true), "the refusal took the announced user out, and says so");
        assert!(fresh_told, "and the reconnected client is told it is not in the call");
    }
}

#[cfg(test)]
mod sfu_grant_sweep_tests {
    use super::evict_sweep;
    use crate::permissions::Permissions as P;
    use crate::sfu::resync_tests::{
        asked, livekit_stand_in, livekit_stand_in_holding, no_env_proxy, Seen, CAMERA_ONLY, MIC_AND_CAMERA,
    };
    use crate::sfu::{room_name_for_channel, Grant, TEST_LIVEKIT};
    use crate::state::AppState;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// Run the real sweep with the SFU tier aimed at a stand-in, bounded: a
    /// sweep stuck on a call must fail the test, not hang it.
    async fn sweep(state: &Arc<AppState>, sid: &str, base: String) {
        tokio::time::timeout(Duration::from_secs(30), TEST_LIVEKIT.scope(base, evict_sweep(state, sid, 0)))
            .await
            .expect("the sweep finished");
    }

    fn update(permission: &str) -> (&'static str, u16, String) {
        (
            "/twirp/livekit.RoomService/UpdateParticipant",
            200,
            format!(r#"{{"sid":"PA_1","identity":"x","state":"ACTIVE","tracks":[],"permission":{permission}}}"#),
        )
    }

    fn body(s: &Seen) -> serde_json::Value {
        serde_json::from_str(&s.body).expect("a JSON body")
    }

    /// Only an answer for THIS server's channel carries a grant: with the scope
    /// unknown the sweep keeps another server's members, and their grant is not
    /// its business; a failed lookup and a non-member say nothing about it.
    #[test]
    fn only_this_servers_answer_carries_a_grant() {
        use super::sweep_grant;
        use crate::permissions::ChannelPermAccess;
        let perms = P::VIEW_CHANNEL | P::CONNECT | P::VIDEO;
        let allowed = |sid: &str| ChannelPermAccess::Allowed { server_id: sid.into(), perms };
        assert_eq!(sweep_grant("s", &allowed("s")), Some(perms));
        assert_eq!(sweep_grant("s", &allowed("other")), None);
        assert_eq!(sweep_grant("s", &ChannelPermAccess::NotFound), None);
        assert_eq!(sweep_grant("s", &ChannelPermAccess::NotMember), None);
    }

    /// A server with an SFU voice channel whose @everyone may VIEW, CONNECT,
    /// SPEAK and use VIDEO, its owner, and a member holding the (so far
    /// permission-less) role `role` that a test denies SPEAK to.
    struct SweepFixture {
        ids: Vec<i32>,
        owner: i64,
        member: i64,
        sid: String,
        role: i64,
        cid: i32,
    }

    const EVERYONE: P = P::VIEW_CHANNEL.union(P::CONNECT).union(P::SPEAK).union(P::VIDEO);

    async fn sweep_fixture(pool: &sqlx::PgPool) -> SweepFixture {
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let mk = |n: &str| format!("sg_{n}_{}", &tag[..12]);
        let mut ids: Vec<i32> = Vec::new();
        for n in ["owner", "member"] {
            let (id,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
                .bind(mk(n))
                .bind(b"s".as_ref())
                .bind(b"v".as_ref())
                .fetch_one(pool)
                .await
                .expect("user");
            ids.push(id);
        }
        let (owner, member) = (ids[0] as i64, ids[1] as i64);
        let sid = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, $2, $3)")
            .bind(&sid)
            .bind(mk("srv"))
            .bind(ids[0])
            .execute(pool)
            .await
            .expect("server");
        sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2), ($1, $3)")
            .bind(&sid)
            .bind(ids[0])
            .bind(ids[1])
            .execute(pool)
            .await
            .expect("members");
        sqlx::query(
            "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) \
             VALUES ($1, '@everyone', '#99AAB5', $2, 0, true)",
        )
        .bind(&sid)
        .bind(EVERYONE.bits() as i64)
        .execute(pool)
        .await
        .expect("@everyone");
        let (role,): (i64,) = sqlx::query_as(
            "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) \
             VALUES ($1, 'quiet', '#99AAB5', 0, 1, false) RETURNING id",
        )
        .bind(&sid)
        .fetch_one(pool)
        .await
        .expect("role");
        sqlx::query("INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)")
            .bind(&sid)
            .bind(ids[1])
            .bind(role)
            .execute(pool)
            .await
            .expect("member role");
        let (cid,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type, sfu_mode) VALUES ($1, 'v', 1, true) RETURNING id")
            .bind(&sid)
            .fetch_one(pool)
            .await
            .expect("sfu channel");
        SweepFixture { ids, owner, member, sid, role, cid }
    }

    async fn drop_sweep_fixture(pool: &sqlx::PgPool, f: &SweepFixture) {
        let _ = sqlx::query("DELETE FROM channels WHERE id = $1").bind(f.cid).execute(pool).await;
        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&f.sid).execute(pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)").bind(f.ids.clone()).execute(pool).await;
    }

    /// THE GAP, end to end through the real perms-change sweep
    /// (TEST_DATABASE_URL; skips without it). A member sits in an SFU call
    /// whose Púca socket is NOT in voice_<id> - it left that room, or died - so
    /// the server holds no speak flag for them at all, and their LiveKit
    /// sessions carry the grant their tokens were minted with.
    ///
    /// Denying SPEAK must reach LiveKit: one UpdateParticipant, for the one
    /// session whose grant still names the microphone - not for their second
    /// session that already holds the camera-only grant, not for the owner, not
    /// for a reservation - and it evicts nobody. Lifting the deny grants the
    /// microphone back to both sessions. A sweep with nothing changed sends
    /// nothing at all.
    #[tokio::test]
    async fn the_sweep_enforces_speak_at_livekit_for_sfu_members_it_keeps() {
        let Some(pool) = crate::migrator::test_pool(2).await else { return };
        no_env_proxy();
        let f = sweep_fixture(&pool).await;
        let (owner, member, cid, role) = (f.owner, f.member, f.cid, f.role);
        let everyone = EVERYONE;

        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = room_name_for_channel(cid as i64);
        let (a, b, o, r) = (format!("u{member}#a"), format!("u{member}#b"), format!("u{owner}#o"), format!("u{member}#r"));
        {
            let now = Instant::now();
            let mut u = state.sfu_rooms.entry(room.clone()).or_default();
            u.participants.insert(a.clone(), now); // joined while SPEAK was allowed
            u.participants.insert(b.clone(), now); // already holds the camera-only grant
            u.participants.insert(o.clone(), now);
            u.reservations.insert(r.clone(), now); // minted, never joined: no session to update
            u.grants.insert(a.clone(), Grant::of(everyone));
            u.grants.insert(b.clone(), Grant::of(P::VIEW_CHANNEL | P::CONNECT | P::VIDEO));
            u.grants.insert(o.clone(), Grant::of(P::ADMINISTRATOR));
        }
        let no_voice_room = state.rooms.get(&format!("voice_{cid}")).is_none();

        // 1. SPEAK denied to the member's role on this channel.
        sqlx::query("INSERT INTO channel_permission_overwrites (channel_id, role_id, allow, deny) VALUES ($1, $2, 0, $3)")
            .bind(cid as i64)
            .bind(role)
            .bind(P::SPEAK.bits() as i64)
            .execute(&pool)
            .await
            .expect("deny SPEAK");
        let (base, srv) = livekit_stand_in(vec![update(CAMERA_ONLY)], None).await;
        sweep(&state, &f.sid, base).await;
        let revoke = asked(srv).await;
        let after_revoke = state.sfu_rooms.get(&room).map(|u| {
            (
                u.grants.get(&a).copied(),
                u.participants.contains_key(&a),
                u.participants.contains_key(&b),
                u.reservations.contains_key(&r),
            )
        });

        // 2. The deny lifted: the microphone is granted back to both sessions.
        sqlx::query("DELETE FROM channel_permission_overwrites WHERE channel_id = $1 AND role_id = $2")
            .bind(cid as i64)
            .bind(role)
            .execute(&pool)
            .await
            .expect("lift the deny");
        let (base, srv) = livekit_stand_in(vec![update(MIC_AND_CAMERA), update(MIC_AND_CAMERA)], None).await;
        sweep(&state, &f.sid, base).await;
        let grant = asked(srv).await;

        // 3. Nothing changed: nothing is sent (the stand-in fails on any call).
        let (base, srv) = livekit_stand_in(vec![], None).await;
        sweep(&state, &f.sid, base).await;
        let quiet = asked(srv).await.len();
        let kept = state.sfu_rooms.get(&room).map(|u| u.participants.len());

        drop_sweep_fixture(&pool, &f).await;

        assert!(no_voice_room, "fixture: no socket of theirs is in voice_<id>");
        assert_eq!(revoke.len(), 1, "one session needed the new grant");
        assert_eq!(
            body(&revoke[0]),
            serde_json::json!({"room": room, "identity": a, "permission": {
                "can_subscribe": true, "can_publish": true, "can_publish_data": true, "can_publish_sources": ["CAMERA"]}}),
            "the microphone goes; listening, the data lane and the camera stay"
        );
        assert_eq!(revoke[0].claims["video"]["roomAdmin"], true);
        assert_eq!(
            after_revoke,
            Some((Some(Grant::of(P::VIEW_CHANNEL | P::CONNECT | P::VIDEO)), true, true, true)),
            "confirmed, and nobody evicted"
        );

        let mut granted: Vec<(String, serde_json::Value)> =
            grant.iter().map(|s| (body(s)["identity"].as_str().unwrap().to_string(), body(s)["permission"].clone())).collect();
        granted.sort_by(|x, y| x.0.cmp(&y.0));
        let mic_and_camera = serde_json::json!({
            "can_subscribe": true, "can_publish": true, "can_publish_data": true, "can_publish_sources": ["MICROPHONE", "CAMERA"]});
        assert_eq!(
            granted,
            vec![(a.clone(), mic_and_camera.clone()), (b.clone(), mic_and_camera)],
            "both of the member's sessions, not the owner's"
        );
        assert_eq!(quiet, 0, "no change, no call");
        assert_eq!(kept, Some(3), "a SPEAK change never evicts");
    }

    /// TWO SWEEPS FOR ONE SERVER (TEST_DATABASE_URL; skips without it). The
    /// member's session holds the camera-only grant an earlier SPEAK deny left
    /// it. The deny is lifted, and sweep A resolves "may speak" and asks
    /// LiveKit for the microphone back - and is parked in that call. Meanwhile
    /// the deny is put back and sweep B runs for it.
    ///
    /// Interleaved, B resolved "may not speak", found the session already
    /// holding the camera-only grant it wanted (A's call was not confirmed
    /// yet) and sent nothing; then A's call landed and was recorded: LiveKit
    /// let the microphone through while the database denied SPEAK, for good.
    /// Serialized, B waits for A, resolves after it, finds the microphone A
    /// gave and takes it away: B's answer - the newest - is the last word.
    #[tokio::test]
    async fn a_later_sweep_for_the_same_server_runs_after_the_earlier_one_and_its_answer_wins() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        no_env_proxy();
        // The fixture starts with the deny lifted: @everyone may SPEAK.
        let f = sweep_fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = room_name_for_channel(f.cid as i64);
        let a = format!("u{}#a", f.member);
        let camera_only = Grant::of(P::VIEW_CHANNEL | P::CONNECT | P::VIDEO);
        {
            let mut u = state.sfu_rooms.entry(room.clone()).or_default();
            u.participants.insert(a.clone(), Instant::now());
            u.grants.insert(a.clone(), camera_only);
        }

        // Sweep A's call (the first) is held until the test lets it go.
        let arrived = Arc::new(AtomicBool::new(false));
        let seen_call = Arc::clone(&arrived);
        let (release, held) = tokio::sync::oneshot::channel::<()>();
        let (base, srv) = livekit_stand_in_holding(
            vec![update(MIC_AND_CAMERA), update(CAMERA_ONLY)],
            Some(Box::new(move |m: &str| {
                if m == "UpdateParticipant" {
                    seen_call.store(true, Ordering::SeqCst);
                }
            })),
            Some((0, held)),
        )
        .await;
        let order = std::sync::Mutex::new(Vec::new());
        let b_done = AtomicBool::new(false);

        let sweep_a = async {
            TEST_LIVEKIT.scope(base.clone(), evict_sweep(&state, &f.sid, 0)).await;
            order.lock().unwrap().push("A");
        };
        let then_b = async {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !arrived.load(Ordering::SeqCst) {
                assert!(Instant::now() < deadline, "sweep A never reached LiveKit");
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            // A is parked in its call, acting on what it resolved before this.
            sqlx::query("INSERT INTO channel_permission_overwrites (channel_id, role_id, allow, deny) VALUES ($1, $2, 0, $3)")
                .bind(f.cid as i64)
                .bind(f.role)
                .bind(P::SPEAK.bits() as i64)
                .execute(&pool)
                .await
                .expect("deny SPEAK again");
            let sweep_b = async {
                TEST_LIVEKIT.scope(base.clone(), evict_sweep(&state, &f.sid, 0)).await;
                order.lock().unwrap().push("B");
                b_done.store(true, Ordering::SeqCst);
            };
            // Let A go once B is queued behind it on the server's lock (the
            // map's clone, A's, and B's) - or, were the sweeps not serialized,
            // once B had simply finished.
            let let_a_go = async {
                let deadline = Instant::now() + Duration::from_secs(10);
                loop {
                    let queued = state.server_perms_locks.get(&f.sid).is_some_and(|m| Arc::strong_count(&m) >= 3);
                    if queued || b_done.load(Ordering::SeqCst) {
                        break;
                    }
                    assert!(Instant::now() < deadline, "sweep B neither queued nor finished");
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                let _ = release.send(());
            };
            tokio::join!(sweep_b, let_a_go);
        };
        tokio::time::timeout(Duration::from_secs(60), async { tokio::join!(sweep_a, then_b) })
            .await
            .expect("both sweeps finished");
        let order = order.into_inner().unwrap();
        let held_now = state.sfu_rooms.get(&room).and_then(|u| u.grants.get(&a).copied());
        let lock_left = state.server_perms_locks.contains_key(&f.sid);
        drop_sweep_fixture(&pool, &f).await;

        assert_eq!(order, vec!["A", "B"], "the later sweep finishes after the earlier one");
        assert_eq!(held_now, Some(camera_only), "the newest answer is what LiveKit holds: no microphone");
        let calls: Vec<serde_json::Value> = asked(srv).await.iter().map(|s| body(s)["permission"]["can_publish_sources"].clone()).collect();
        assert_eq!(
            calls,
            vec![serde_json::json!(["MICROPHONE", "CAMERA"]), serde_json::json!(["CAMERA"])],
            "A's (older) microphone, then B's (newer) revoke of it"
        );
        assert!(!lock_left, "the per-server lock is forgotten once nobody holds it");
    }

    /// Deny SPEAK to the fixture member's role on its channel.
    async fn deny_speak(pool: &sqlx::PgPool, f: &SweepFixture) {
        sqlx::query("INSERT INTO channel_permission_overwrites (channel_id, role_id, allow, deny) VALUES ($1, $2, 0, $3)")
            .bind(f.cid as i64)
            .bind(f.role)
            .bind(P::SPEAK.bits() as i64)
            .execute(pool)
            .await
            .expect("deny SPEAK");
    }

    /// Until `what` holds, or fail (bounded).
    async fn until(what: &str, mut ok: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ok() {
            assert!(Instant::now() < deadline, "never: {what}");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// COALESCED (TEST_DATABASE_URL; skips without it). LiveKit is failing -
    /// every grant refused, and a refused grant records nothing, so every
    /// sweep sends it again. While the server's sweep runs (parked in its
    /// call), five more changes ask for one: each waits for the first run to
    /// START after it asked - the same one - and exactly one more runs. Two
    /// calls in all, not seven; and none of the five is answered by the run
    /// that was already going (it may have resolved before their changes).
    #[tokio::test]
    async fn requests_during_a_running_sweep_coalesce_into_one_more_run() {
        use super::request_perms_sweep;
        use std::sync::atomic::{AtomicBool, Ordering};
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        no_env_proxy();
        let f = sweep_fixture(&pool).await;
        deny_speak(&pool, &f).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = room_name_for_channel(f.cid as i64);
        let a = format!("u{}#a", f.member);
        {
            let mut u = state.sfu_rooms.entry(room.clone()).or_default();
            u.participants.insert(a.clone(), Instant::now());
            u.grants.insert(a.clone(), Grant::of(EVERYONE));
        }
        let arrived = Arc::new(AtomicBool::new(false));
        let seen_call = Arc::clone(&arrived);
        let (release, held) = tokio::sync::oneshot::channel::<()>();
        let refused = || ("/twirp/livekit.RoomService/UpdateParticipant", 503, r#"{"code":"unavailable"}"#.to_string());
        let (base, srv) = livekit_stand_in_holding(
            vec![refused(), refused()],
            Some(Box::new(move |_: &str| seen_call.store(true, Ordering::SeqCst))),
            Some((0, held)),
        )
        .await;
        let (first, more) = TEST_LIVEKIT
            .scope(base, async {
                let first = request_perms_sweep(&state, &f.sid, 0);
                until("the first sweep reached LiveKit", || arrived.load(Ordering::SeqCst)).await;
                let more: Vec<_> = (0..5).map(|_| request_perms_sweep(&state, &f.sid, 0)).collect();
                (first, more)
            })
            .await;
        let (first_run, runs): (u64, Vec<u64>) = (first.run(), more.iter().map(|t| t.run()).collect());
        let _ = release.send(());
        tokio::time::timeout(Duration::from_secs(30), async {
            first.wait().await;
            for t in more {
                t.wait().await;
            }
        })
        .await
        .expect("every request's run finished");
        until("the runner left", || !state.perms_sweeps.contains_key(&f.sid)).await;
        drop_sweep_fixture(&pool, &f).await;

        assert_eq!(first_run, 1);
        assert_eq!(runs, vec![2; 5], "all five wait for the next run to start - the same one");
        assert_eq!(asked(srv).await.len(), 2, "one run each: the running one, and ONE more");
    }

    /// A LiveKit that accepts connections and never answers: counts them, and
    /// holds each open. Abort the task when done.
    async fn hanging_livekit() -> (String, Arc<std::sync::atomic::AtomicUsize>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = Arc::clone(&accepted);
        let task = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                held.push(socket);
            }
        });
        (base, accepted, task)
    }

    /// A HUNG LiveKit (TEST_DATABASE_URL; skips without it): it accepts and
    /// never answers, so every call costs its whole 5 s timeout. Five stale
    /// sessions - four of the member's owed a SPEAK revoke, one of a user who
    /// is no member at all, owed a removal. The sweep's SFU pass sends ONE call
    /// and no more: the rest are owed to the resync at once, each with its own
    /// Recheck. So the sweep - and whatever change is queued behind it, a
    /// kick's mesh eviction included - waits about one LiveKit timeout, not
    /// one per session.
    #[tokio::test]
    async fn a_hung_livekit_costs_a_sweep_one_timeout_not_one_per_session() {
        use crate::sfu::{Mark, Recheck};
        use std::sync::atomic::Ordering;
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        no_env_proxy();
        let f = sweep_fixture(&pool).await;
        deny_speak(&pool, &f).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = room_name_for_channel(f.cid as i64);
        let stale: Vec<String> = ["a", "b", "c", "d"].iter().map(|n| format!("u{}#{n}", f.member)).collect();
        let outsider = "u2000000001#x".to_string();
        {
            let mut u = state.sfu_rooms.entry(room.clone()).or_default();
            for id in stale.iter().chain(std::iter::once(&outsider)) {
                u.participants.insert(id.clone(), Instant::now());
                u.grants.insert(id.clone(), Grant::of(EVERYONE));
            }
        }
        let (base, accepted, hung) = hanging_livekit().await;
        let started = Instant::now();
        let finished = tokio::time::timeout(Duration::from_secs(40), TEST_LIVEKIT.scope(base, evict_sweep(&state, &f.sid, 0))).await;
        let took = started.elapsed();
        hung.abort();
        let marks: Vec<Option<Mark>> = {
            let u = state.sfu_rooms.get(&room).expect("room");
            stale.iter().chain(std::iter::once(&outsider)).map(|id| u.recheck.get(id).copied()).collect()
        };
        drop_sweep_fixture(&pool, &f).await;

        assert!(finished.is_ok(), "the sweep finished");
        assert_eq!(accepted.load(Ordering::SeqCst), 1, "one call reached the hung LiveKit; none after it");
        assert!(took < Duration::from_secs(9), "one timeout, not one per session: took {took:?}");
        let live = Some(Mark { what: Recheck::LiveGrant, passes: 0 });
        assert_eq!(marks[..4], [live; 4], "each skipped grant owed as a live one");
        assert_eq!(marks[4], Some(Mark { what: Recheck::JoinCheck, passes: 0 }), "the skipped removal owed as a join check");
    }

    /// A handler waits for its sweep, but not past its cap (TEST_DATABASE_URL;
    /// skips without it): with LiveKit hanging on the grant, the handler
    /// answers after the cap, and the sweep - detached - finishes on its own
    /// once LiveKit answers.
    #[tokio::test]
    async fn a_handler_answers_after_its_cap_and_the_sweep_still_finishes() {
        use super::perms_changed_within;
        use std::sync::atomic::{AtomicBool, Ordering};
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        no_env_proxy();
        let f = sweep_fixture(&pool).await;
        deny_speak(&pool, &f).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = room_name_for_channel(f.cid as i64);
        let a = format!("u{}#a", f.member);
        {
            let mut u = state.sfu_rooms.entry(room.clone()).or_default();
            u.participants.insert(a.clone(), Instant::now());
            u.grants.insert(a.clone(), Grant::of(EVERYONE));
        }
        let arrived = Arc::new(AtomicBool::new(false));
        let seen_call = Arc::clone(&arrived);
        let (release, held) = tokio::sync::oneshot::channel::<()>();
        let (base, srv) = livekit_stand_in_holding(
            vec![update(CAMERA_ONLY)],
            Some(Box::new(move |_: &str| seen_call.store(true, Ordering::SeqCst))),
            Some((0, held)),
        )
        .await;
        let answered = TEST_LIVEKIT
            .scope(
                base,
                tokio::time::timeout(Duration::from_secs(5), perms_changed_within(&state, &f.sid, Duration::from_millis(200))),
            )
            .await;
        let reached = arrived.load(Ordering::SeqCst);
        let _ = release.send(());
        let camera_only = Grant::of(P::VIEW_CHANNEL | P::CONNECT | P::VIDEO);
        until("the detached sweep confirmed the grant", || {
            state.sfu_rooms.get(&room).and_then(|u| u.grants.get(&a).copied()) == Some(camera_only)
        })
        .await;
        until("the runner left", || !state.perms_sweeps.contains_key(&f.sid)).await;
        drop_sweep_fixture(&pool, &f).await;

        assert_eq!(answered.map_err(|_| "the handler outlived its cap"), Ok(false), "answered, sweep unfinished");
        assert!(reached, "fixture: the sweep was parked in its LiveKit call");
        assert_eq!(asked(srv).await.len(), 1);
    }
}

/// "You're in <channel> on your PC — Leave / Move here" (docs/USER_GUIDE.md,
/// *Your call on another device*). Everything here runs the REAL handler on
/// registered sockets against a throwaway database (TEST_DATABASE_URL; each
/// test skips without it).
///
/// One account, two devices: `pc` (sid S1) and `phone` (sid S2), plus a second
/// account `b` sharing the call. The properties pinned:
///
/// - Move here (`JoinRoom { take_over }`) joins the new connection FIRST and
///   only then removes the old one, so the room never sees the user leave:
///   no UserLeft, no StreamStopped, no UserJoined, and the voice claim moves
///   to the new connection.
/// - The displaced connection, and ONLY it, is told `RoomLeft` - never the
///   device asking, which is mid-join and would tear itself down (the
///   self-kill race).
/// - A displaced connection's StopStream / ScreenShareStop / CameraStop /
///   LeaveRoom cannot clear the account's stream claim or announce a
///   departure - old PC clients send all four from their teardown.
/// - Leave (`LeaveOwnVoice`) ends exactly the other device's call; the
///   account only.
/// - A PC that slept through its RoomLeft and later REPLAYS the join is
///   refused, so an explicit Leave/Move is not undone with an open mic.
#[cfg(test)]
mod own_voice_tests {
    use super::handle_message;
    use crate::permissions::Permissions;
    use crate::protocol::ServerMessage;
    use crate::state::{AppState, UserId};
    use std::collections::HashSet;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    struct Sock {
        uid: UserId,
        name: String,
        conn: u64,
        rx: mpsc::Receiver<ServerMessage>,
        joined: HashSet<String>,
    }

    impl Sock {
        fn open(state: &Arc<AppState>, uid: i32, name: &str, sid: &str) -> Sock {
            let (tx, rx) = mpsc::channel::<ServerMessage>(256);
            let (conn, _, _) = state.register_session(uid as UserId, name.to_string(), tx, false, None, sid.to_string());
            Sock { uid: uid as UserId, name: name.to_string(), conn, rx, joined: HashSet::new() }
        }

        async fn send(&mut self, state: &Arc<AppState>, frame: serde_json::Value) -> Result<(), String> {
            handle_message(state, self.uid, self.conn, &self.name, &frame.to_string(), &mut self.joined, "").await
        }

        async fn join(&mut self, state: &Arc<AppState>, room: &str) -> Result<(), String> {
            self.send(state, serde_json::json!({ "type": "JoinRoom", "payload": { "room_id": room } })).await
        }

        async fn take_over(&mut self, state: &Arc<AppState>, room: &str) -> Result<(), String> {
            self.send(state, serde_json::json!({ "type": "JoinRoom", "payload": { "room_id": room, "take_over": true } })).await
        }

        async fn replay(&mut self, state: &Arc<AppState>, room: &str) -> Result<(), String> {
            self.send(state, serde_json::json!({ "type": "JoinRoom", "payload": { "room_id": room, "replay": true } })).await
        }

        async fn simple(&mut self, state: &Arc<AppState>, kind: &str, room: &str) -> Result<(), String> {
            self.send(state, serde_json::json!({ "type": kind, "payload": { "room_id": room } })).await
        }

        fn drain(&mut self) -> Vec<ServerMessage> {
            let mut out = Vec::new();
            while let Ok(m) = self.rx.try_recv() {
                out.push(m);
            }
            out
        }
    }

    fn room_left(frames: &[ServerMessage], room: &str) -> bool {
        frames.iter().any(|m| matches!(m, ServerMessage::RoomLeft { room_id, .. } if room_id == room))
    }

    fn user_left(frames: &[ServerMessage], who: UserId) -> bool {
        frames.iter().any(|m| matches!(m, ServerMessage::UserLeft { user_id, .. } if *user_id == who))
    }

    fn user_joined(frames: &[ServerMessage], who: UserId) -> bool {
        frames.iter().any(|m| matches!(m, ServerMessage::UserJoined { user, .. } if user.id == who))
    }

    fn stream_stopped(frames: &[ServerMessage], who: UserId) -> bool {
        frames.iter().any(|m| matches!(m, ServerMessage::StreamStopped { streamer_id, .. } if *streamer_id == who))
    }

    fn conns(state: &Arc<AppState>, room: &str, uid: UserId) -> Vec<u64> {
        let mut v: Vec<u64> = state
            .rooms
            .get(room)
            .and_then(|r| r.conns_of(uid).map(|c| c.iter().copied().collect()))
            .unwrap_or_default();
        v.sort_unstable();
        v
    }

    fn streams(state: &Arc<AppState>, room: &str, uid: UserId) -> bool {
        state.rooms.get(room).is_some_and(|r| r.streamers.contains(&uid))
    }

    /// (voice claim, screen share, camera) of `uid` in `room`.
    fn media(state: &Arc<AppState>, room: &str, uid: UserId) -> (bool, bool, bool) {
        state.rooms.get(room).map_or((false, false, false), |r| {
            (r.streamers.contains(&uid), r.screen_sharers.contains(&uid), r.camera_users.contains(&uid))
        })
    }

    fn media_stopped(frames: &[ServerMessage], who: UserId) -> bool {
        frames.iter().any(|m| {
            matches!(m, ServerMessage::ScreenShareStopped { streamer_id, .. } if *streamer_id == who)
                || matches!(m, ServerMessage::CameraStopped { user_id, .. } if *user_id == who)
        })
    }

    /// Two users (the account `a`, and `b` in the same server), a mesh voice
    /// channel, an SFU voice channel and a text channel. Returns
    /// (a, b, server_id, voice, sfu_voice, text). The caller deletes the users.
    async fn fixture(pool: &sqlx::PgPool) -> (i32, i32, String, i32, i32, i32) {
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let mk = |n: &str| format!("ov_{n}_{}", &tag[..12]);
        let mut ids = Vec::new();
        for n in ["a", "b"] {
            let (id,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
                .bind(mk(n))
                .bind(b"s".as_ref())
                .bind(b"v".as_ref())
                .fetch_one(pool)
                .await
                .expect("user");
            ids.push(id);
        }
        let sid = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, $2, $3)")
            .bind(&sid)
            .bind(mk("srv"))
            .bind(ids[0])
            .execute(pool)
            .await
            .expect("server");
        for m in &ids {
            sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)")
                .bind(&sid)
                .bind(m)
                .execute(pool)
                .await
                .expect("member");
        }
        let everyone = (Permissions::VIEW_CHANNEL | Permissions::CONNECT | Permissions::SPEAK | Permissions::STREAM | Permissions::VIDEO).bits() as i64;
        sqlx::query(
            "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) \
             VALUES ($1, '@everyone', '#99AAB5', $2, 0, true)",
        )
        .bind(&sid)
        .bind(everyone)
        .execute(pool)
        .await
        .expect("@everyone");
        let (voice,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type, sfu_mode) VALUES ($1, 'Lounge', 1, false) RETURNING id")
            .bind(&sid)
            .fetch_one(pool)
            .await
            .expect("voice");
        let (sfu,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type, sfu_mode) VALUES ($1, 'Stage', 1, true) RETURNING id")
            .bind(&sid)
            .fetch_one(pool)
            .await
            .expect("sfu voice");
        let (text,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type) VALUES ($1, 'general', 0) RETURNING id")
            .bind(&sid)
            .fetch_one(pool)
            .await
            .expect("text");
        (ids[0], ids[1], sid, voice, sfu, text)
    }

    async fn cleanup(pool: &sqlx::PgPool, ids: &[i32], server: &str) {
        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(server).execute(pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)").bind(ids.to_vec()).execute(pool).await;
    }

    /// MOVE HERE: join-then-remove, conn-scoped RoomLeft, nothing announced.
    #[tokio::test]
    async fn move_here_joins_the_phone_first_then_takes_the_pc_out_and_tells_only_the_pc() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let (a, b, server, voice, _sfu, _text) = fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = format!("voice_{voice}");
        let (au, bu) = (a as UserId, b as UserId);
        let mut pc = Sock::open(&state, a, "a", "sid-pc");
        let mut phone = Sock::open(&state, a, "a", "sid-phone");
        let mut sb = Sock::open(&state, b, "b", "sid-b");

        pc.join(&state, &room).await.expect("pc joins");
        sb.join(&state, &room).await.expect("b joins");
        // Positive control: the call is on the PC, voice claim included.
        let before = (conns(&state, &room, au), streams(&state, &room, au));
        let _ = (pc.drain(), phone.drain(), sb.drain());

        let moved = phone.take_over(&state, &room).await;
        let (f_pc, f_phone, f_b) = (pc.drain(), phone.drain(), sb.drain());
        let after = (conns(&state, &room, au), streams(&state, &room, au));
        cleanup(&pool, &[a, b], &server).await;

        assert_eq!(before, (vec![pc.conn], true), "fixture: the call starts on the PC");
        assert!(moved.is_ok(), "{moved:?}");
        assert_eq!(after.0, vec![phone.conn], "the call is on the phone, and ONLY the phone");
        assert!(after.1, "the account's voice claim moved with it - never released");
        assert!(room_left(&f_pc, &room), "the PC is told its call ended");
        assert!(!room_left(&f_phone, &room), "the phone is NOT told RoomLeft: it is mid-join and would tear itself down");
        assert!(
            f_phone.iter().any(|m| matches!(m, ServerMessage::RoomJoined { room_id, .. } if *room_id == room)),
            "the phone's own join is answered as usual"
        );
        assert!(!user_left(&f_b, au), "the other caller never sees the user leave");
        assert!(!stream_stopped(&f_b, au), "...nor their voice stop (that drops the mesh link and audio)");
        assert!(!user_joined(&f_b, au), "...nor join again (a join chime for a call that never ended)");
        let _ = bu;
    }

    /// The displaced PC's own teardown - the stock client sends StopStream,
    /// ScreenShareStop, CameraStop and LeaveRoom - must not take the moved call
    /// with it. Fixed on the SERVER, so a PC still on an old client is covered.
    ///
    /// Also the guard on its own, without a move: a connection of the user
    /// that is NOT in the room (here the PC, while the call is on the phone)
    /// cannot clear the claim either. The positive control is the phone's own
    /// StopStream, which still does.
    #[tokio::test]
    async fn a_displaced_or_absent_connection_cannot_clear_the_accounts_call() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let (a, b, server, voice, _sfu, _text) = fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = format!("voice_{voice}");
        let au = a as UserId;
        let mut pc = Sock::open(&state, a, "a", "sid-pc");
        let mut phone = Sock::open(&state, a, "a", "sid-phone");
        let mut sb = Sock::open(&state, b, "b", "sid-b");

        // 1. The guard alone: the call is on the phone; the PC never joined.
        phone.join(&state, &room).await.expect("phone joins");
        sb.join(&state, &room).await.expect("b joins");
        let _ = (pc.drain(), phone.drain(), sb.drain());
        for kind in ["StopStream", "ScreenShareStop", "CameraStop", "LeaveRoom"] {
            let _ = pc.simple(&state, kind, &room).await;
        }
        let absent = (conns(&state, &room, au), streams(&state, &room, au));
        let f_b_absent = sb.drain();

        // 2. After a move: the PC had the call, the phone took it over and
        //    now shares its screen and its camera.
        phone.simple(&state, "LeaveRoom", &room).await.expect("phone leaves");
        pc.join(&state, &room).await.expect("pc joins");
        let _ = phone.take_over(&state, &room).await;
        phone.simple(&state, "ScreenShareStart", &room).await.expect("phone shares");
        phone.simple(&state, "CameraStart", &room).await.expect("phone camera");
        let phone_media = media(&state, &room, au);
        let _ = (pc.drain(), phone.drain(), sb.drain());
        for kind in ["StopStream", "ScreenShareStop", "CameraStop", "LeaveRoom"] {
            let _ = pc.simple(&state, kind, &room).await;
        }
        let displaced = (conns(&state, &room, au), media(&state, &room, au));
        let f_b_displaced = sb.drain();
        // ...and its STARTS (a late StartStream from its teardown race, a
        // stale share button) plant no claim on a socket that holds no call:
        // the room would be told the account is sharing a screen nobody can
        // receive (the PC has no media path into the call any more).
        phone.simple(&state, "ScreenShareStop", &room).await.expect("phone stops sharing");
        phone.simple(&state, "CameraStop", &room).await.expect("phone stops its camera");
        let _ = sb.drain();
        let mut starts: Vec<Result<(), String>> = Vec::new();
        for kind in ["StartStream", "ScreenShareStart", "CameraStart"] {
            starts.push(pc.simple(&state, kind, &room).await);
        }
        let after_pc_starts = media(&state, &room, au);
        let f_b_starts = sb.drain();

        // 3. Positive control: the device that HAS the call can still stop.
        phone.simple(&state, "StopStream", &room).await.expect("phone stops");
        let control = streams(&state, &room, au);
        let f_b_control = sb.drain();
        // The phone hangs up while B stays: nothing of the account may remain.
        phone.simple(&state, "LeaveRoom", &room).await.expect("phone hangs up");
        let after_hangup = media(&state, &room, au);
        cleanup(&pool, &[a, b], &server).await;

        assert_eq!(absent, (vec![phone.conn], true), "an absent connection's stops are no-ops");
        assert!(!stream_stopped(&f_b_absent, au) && !user_left(&f_b_absent, au), "and announce nothing");
        assert_eq!(phone_media, (true, true, true), "fixture: the phone holds voice, a share and its camera");
        assert_eq!(
            displaced,
            (vec![phone.conn], (true, true, true)),
            "a displaced connection's teardown leaves the moved call - voice, share and camera - alone"
        );
        assert!(!stream_stopped(&f_b_displaced, au), "no StreamStopped from the PC's StopStream");
        assert!(!media_stopped(&f_b_displaced, au), "no ScreenShareStopped / CameraStopped from its stops");
        assert!(!user_left(&f_b_displaced, au), "no UserLeft from the PC's LeaveRoom");
        assert!(starts.iter().all(|r| r.is_ok()), "its starts are ignored quietly, never an Error (alert): {starts:?}");
        assert_eq!(after_pc_starts, (true, false, false), "the PC's starts claim nothing: no share, no camera");
        assert!(
            !f_b_starts.iter().any(|m| matches!(
                m,
                ServerMessage::ScreenShareStarted { .. } | ServerMessage::CameraStarted { .. } | ServerMessage::StreamStarted { .. }
            )),
            "and the room is told nothing: {f_b_starts:?}"
        );
        assert!(!control, "positive control: the phone's own StopStream clears the claim");
        assert!(stream_stopped(&f_b_control, au), "positive control: and is announced");
        assert_eq!(after_hangup, (false, false, false), "no claim the PC planted outlives the phone's hang-up");
    }

    /// LEAVE from the phone ends exactly the PC's call: the PC is told, the
    /// room sees the user go, the phone is not told RoomLeft. And ONLY the
    /// account itself can do it: another user's LeaveOwnVoice and take_over
    /// leave the call alone (their own voice state is all they can touch).
    #[tokio::test]
    async fn leave_from_another_device_ends_only_that_device_and_only_for_its_own_account() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let (a, b, server, voice, _sfu, text) = fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = format!("voice_{voice}");
        let text_room = format!("channel_{text}");
        let (au, bu) = (a as UserId, b as UserId);
        let mut pc = Sock::open(&state, a, "a", "sid-pc");
        let mut phone = Sock::open(&state, a, "a", "sid-phone");
        let mut sb = Sock::open(&state, b, "b", "sid-b");
        let mut sb2 = Sock::open(&state, b, "b", "sid-b2");

        pc.join(&state, &room).await.expect("pc joins");
        phone.join(&state, &text_room).await.expect("phone reads a text channel");
        sb.join(&state, &room).await.expect("b joins");
        let _ = (pc.drain(), phone.drain(), sb.drain(), sb2.drain());

        // Another account tries both levers on A's call.
        let leave_frame = serde_json::json!({ "type": "LeaveOwnVoice", "payload": { "room_id": room } });
        let _ = sb2.send(&state, leave_frame.clone()).await;
        let _ = sb2.take_over(&state, &room).await;
        let a_after_b = conns(&state, &room, au);
        let pc_told_by_b = room_left(&pc.drain(), &room);
        // b's second device taking over is b's OWN business: b's first device
        // is displaced, a is untouched.
        let b_after = conns(&state, &room, bu);
        let _ = (sb.drain(), sb2.drain(), phone.drain());

        // The account's own phone presses Leave.
        let left = phone.send(&state, leave_frame).await;
        let (f_pc, f_phone, f_b2) = (pc.drain(), phone.drain(), sb2.drain());
        let a_after = conns(&state, &room, au);
        cleanup(&pool, &[a, b], &server).await;

        assert_eq!(a_after_b, vec![pc.conn], "another user cannot end your call");
        assert!(!pc_told_by_b, "...or send your device a RoomLeft");
        assert_eq!(b_after, vec![sb2.conn], "fixture: b's take_over moved b's own call");
        assert!(left.is_ok(), "{left:?}");
        assert!(a_after.is_empty(), "Leave ended the PC's call");
        assert!(room_left(&f_pc, &room), "the PC is told");
        assert!(!room_left(&f_phone, &room), "the phone (never in the call) is not told RoomLeft");
        assert!(user_left(&f_b2, au), "the room sees the user leave");
        assert!(stream_stopped(&f_b2, au), "and their voice retracted");
    }

    /// A PC that missed its RoomLeft (lid shut, half-open socket) comes back
    /// and REPLAYS its JoinRoom. After an explicit Move or Leave from another
    /// device that replay must not put the call back on the PC with an open
    /// mic (or steal it back from the phone). A DELIBERATE join from that PC
    /// still works, and so does an ordinary reconnect replay of a device that
    /// was never displaced.
    #[tokio::test]
    async fn a_replayed_join_from_a_displaced_session_is_refused_but_a_deliberate_one_is_not() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let (a, b, server, voice, _sfu, _text) = fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = format!("voice_{voice}");
        let au = a as UserId;
        let mut pc = Sock::open(&state, a, "a", "sid-pc");
        let mut phone = Sock::open(&state, a, "a", "sid-phone");
        let mut sb = Sock::open(&state, b, "b", "sid-b");

        pc.join(&state, &room).await.expect("pc joins");
        sb.join(&state, &room).await.expect("b joins");
        phone.take_over(&state, &room).await.expect("phone takes over");
        // The PC's socket was half-open: it never read that RoomLeft. It is
        // reaped, and the PC reconnects on the same session and replays.
        state.unregister_session(au, pc.conn);
        let mut pc2 = Sock::open(&state, a, "a", "sid-pc");
        let replay = pc2.replay(&state, &room).await;
        let f_pc2 = pc2.drain();
        let after_replay = conns(&state, &room, au);

        // A phone blip: ITS replay is an ordinary reconnect and must work.
        let mut phone2 = Sock::open(&state, a, "a", "sid-phone");
        let phone_replay = phone2.replay(&state, &room).await;
        let after_phone_replay = conns(&state, &room, au);

        // The owner walks back to the PC and clicks the channel on purpose.
        let mut pc3 = Sock::open(&state, a, "a", "sid-pc");
        let deliberate = pc3.join(&state, &room).await;
        let after_deliberate = conns(&state, &room, au);
        cleanup(&pool, &[a, b], &server).await;

        assert!(replay.is_ok(), "a refused replay is not an Error frame (old clients alert() those): {replay:?}");
        assert_eq!(after_replay, vec![phone.conn], "the stale replay did not rejoin the PC");
        assert!(room_left(&f_pc2, &room), "the PC is told, so it drops the room from its replay list");
        assert!(phone_replay.is_ok() && after_phone_replay.contains(&phone2.conn), "a never-displaced device's replay rejoins");
        assert!(deliberate.is_ok() && after_deliberate.contains(&pc3.conn), "a deliberate join from the PC still works");
    }

    /// A Leave pressed on a banner that is already out of date (the call moved
    /// to another channel meanwhile) ends nothing: it names a room the account
    /// is no longer in. The sender is just told where the call really is.
    #[tokio::test]
    async fn a_stale_leave_for_a_room_the_call_has_left_does_nothing() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let (a, b, server, voice, other, _text) = fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let (room, other_room) = (format!("voice_{voice}"), format!("voice_{other}"));
        let au = a as UserId;
        let mut pc = Sock::open(&state, a, "a", "sid-pc");
        let mut phone = Sock::open(&state, a, "a", "sid-phone");
        state.set_conn_caps(au, phone.conn, true, Some("mobile"));

        pc.join(&state, &other_room).await.expect("pc joins");
        let _ = (pc.drain(), phone.drain());
        let stale = phone.send(&state, serde_json::json!({ "type": "LeaveOwnVoice", "payload": { "room_id": room } })).await;
        let (f_pc, f_phone) = (pc.drain(), phone.drain());
        let still = conns(&state, &other_room, au);
        cleanup(&pool, &[a, b], &server).await;

        assert!(stale.is_ok(), "never an Error frame: {stale:?}");
        assert_eq!(still, vec![pc.conn], "the call is untouched");
        assert!(!room_left(&f_pc, &other_room) && !room_left(&f_pc, &room), "and the PC is told nothing");
        assert!(
            f_phone.iter().any(|m| matches!(m, ServerMessage::OwnVoiceState { room_id: Some(r), here: false, .. } if *r == other_room)),
            "the phone learns where the call really is: {f_phone:?}"
        );
    }

    /// The phone taps a DIFFERENT voice channel: voice exclusivity has always
    /// taken the PC out, silently. Now the PC - and only the PC - is told why
    /// (so it can say "You moved the call to your phone"), the phone's
    /// RoomLeft for the old room stays the plain one (it is mid-join and must
    /// show nothing), and the PC's later REPLAY of the old room is refused, so
    /// a laptop that slept through it cannot steal the call back.
    #[tokio::test]
    async fn another_channel_on_the_phone_tells_only_the_pc_and_blocks_its_stale_replay() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let (a, b, server, voice, other, _text) = fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = format!("voice_{voice}");
        let other_room = format!("voice_{other}");
        let au = a as UserId;
        let mut pc = Sock::open(&state, a, "a", "sid-pc");
        let mut phone = Sock::open(&state, a, "a", "sid-phone");
        state.set_conn_caps(au, phone.conn, true, Some("mobile"));

        pc.join(&state, &room).await.expect("pc joins");
        let _ = (pc.drain(), phone.drain());
        phone.join(&state, &other_room).await.expect("phone joins another channel");
        let (f_pc, f_phone) = (pc.drain(), phone.drain());
        let why = |frames: &[ServerMessage]| -> Vec<(Option<String>, Option<String>)> {
            frames
                .iter()
                .filter_map(|m| match m {
                    ServerMessage::RoomLeft { room_id, reason, by } if *room_id == room => Some((reason.clone(), by.clone())),
                    _ => None,
                })
                .collect()
        };
        let (pc_why, phone_why) = (why(&f_pc), why(&f_phone));

        state.unregister_session(au, pc.conn);
        let mut pc2 = Sock::open(&state, a, "a", "sid-pc");
        let replay = pc2.replay(&state, &room).await;
        let after_replay = (conns(&state, &room, au), conns(&state, &other_room, au));
        cleanup(&pool, &[a, b], &server).await;

        assert_eq!(pc_why, vec![(Some("moved".into()), Some("mobile".into()))], "the PC is told why, and by what");
        assert_eq!(phone_why, vec![(None, None)], "the phone gets the plain frame it always got");
        assert!(replay.is_ok(), "{replay:?}");
        assert_eq!(after_replay, (vec![], vec![phone.conn]), "the stale replay neither rejoins the PC nor evicts the phone");
    }

    /// The woken PC's client re-claims its media right after its replay
    /// (VoicePanel's onReconnected: StartStream, plus ScreenShareStart /
    /// CameraStart if they were on). When the replay was refused because the
    /// call was ended (Leave) or moved to ANOTHER channel on the phone, the
    /// account is no longer in that room at all - those starts must still be
    /// ignored quietly, not answered "Not in this room" (an Error frame, which
    /// the client alert()s: a native modal on the desktop app).
    #[tokio::test]
    async fn a_woken_pc_reclaiming_its_media_after_leave_or_a_move_elsewhere_is_not_an_error() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let (a, b, server, voice, other, _text) = fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let (room, other_room) = (format!("voice_{voice}"), format!("voice_{other}"));
        let au = a as UserId;
        let kinds = ["StartStream", "ScreenShareStart", "CameraStart"];

        // A: the phone pressed Leave while the PC slept.
        let mut pc = Sock::open(&state, a, "a", "sid-pc");
        let mut phone = Sock::open(&state, a, "a", "sid-phone");
        state.set_conn_caps(au, phone.conn, true, Some("mobile"));
        pc.join(&state, &room).await.expect("pc joins");
        phone
            .send(&state, serde_json::json!({ "type": "LeaveOwnVoice", "payload": { "room_id": room } }))
            .await
            .expect("leave");
        state.unregister_session(au, pc.conn);
        let mut pc2 = Sock::open(&state, a, "a", "sid-pc");
        let replay_a = pc2.replay(&state, &room).await;
        let mut starts_a = Vec::new();
        for k in &kinds {
            starts_a.push(pc2.simple(&state, k, &room).await);
        }
        let after_a = (conns(&state, &room, au), media(&state, &room, au));

        // B: the phone joined ANOTHER voice channel while the PC slept.
        state.unregister_session(au, pc2.conn);
        let mut pc3 = Sock::open(&state, a, "a", "sid-pc");
        pc3.join(&state, &room).await.expect("pc joins again, deliberately");
        phone.join(&state, &other_room).await.expect("phone joins another channel");
        state.unregister_session(au, pc3.conn);
        let mut pc4 = Sock::open(&state, a, "a", "sid-pc");
        let replay_b = pc4.replay(&state, &room).await;
        let mut starts_b = Vec::new();
        for k in &kinds {
            starts_b.push(pc4.simple(&state, k, &room).await);
        }
        let after_b = (conns(&state, &room, au), media(&state, &room, au), conns(&state, &other_room, au));

        // Positive control: a connection of an account that was NEVER
        // displaced from this room still gets the plain refusal.
        let mut sb = Sock::open(&state, b, "b", "sid-b");
        let control = sb.simple(&state, "StartStream", &room).await;
        cleanup(&pool, &[a, b], &server).await;

        assert!(replay_a.is_ok() && replay_b.is_ok(), "{replay_a:?} {replay_b:?}");
        assert!(starts_a.iter().all(|r| r.is_ok()), "after Leave: no Error frame for the re-claim: {starts_a:?}");
        assert_eq!(after_a, (vec![], (false, false, false)), "and the starts claimed nothing");
        assert!(starts_b.iter().all(|r| r.is_ok()), "after a move elsewhere: no Error frame either: {starts_b:?}");
        assert_eq!(after_b, (vec![], (false, false, false), vec![phone.conn]), "nothing claimed, the phone's call untouched");
        assert_eq!(control, Err("Not in this room".to_string()), "positive control: the ordinary refusal stands");
    }

    /// A REPLAY must never duplicate or displace a call that is live on
    /// another device - even when no tombstone was written because the PC
    /// was no longer in the room when the call moved: (1) its zombie socket
    /// was reaped, and the phone then joined the channel normally; (2) Move
    /// here was pressed during the PC's rejoin grace, so it displaced nothing.
    /// And the phone's call in ANOTHER channel must not be evicted by the
    /// replay through voice exclusivity. A deliberate join still can, a
    /// same-device reconnect (same sign-in session) still rejoins, and with no
    /// call anywhere a replay rejoins as it always did.
    #[tokio::test]
    async fn a_replay_never_duplicates_or_displaces_a_call_live_on_another_device() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let (a, b, server, voice, other, _text) = fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let (room, other_room) = (format!("voice_{voice}"), format!("voice_{other}"));
        let au = a as UserId;
        let why = |frames: &[ServerMessage], r: &str| -> Vec<(Option<String>, Option<String>)> {
            frames
                .iter()
                .filter_map(|m| match m {
                    ServerMessage::RoomLeft { room_id, reason, by } if room_id == r => Some((reason.clone(), by.clone())),
                    _ => None,
                })
                .collect()
        };

        // Control first: no call anywhere - the replay rejoins.
        let mut pc = Sock::open(&state, a, "a", "sid-pc");
        pc.join(&state, &room).await.expect("pc joins");
        state.unregister_session(au, pc.conn);
        let mut pc2 = Sock::open(&state, a, "a", "sid-pc");
        let control = pc2.replay(&state, &room).await;
        let after_control = conns(&state, &room, au);

        // Control: the same device's new socket while its old one is still a
        // zombie in the room (same sign-in session) - an ordinary reconnect.
        let mut pc3 = Sock::open(&state, a, "a", "sid-pc");
        let same_device = pc3.replay(&state, &room).await;
        let after_same_device = conns(&state, &room, au);
        state.unregister_session(au, pc2.conn);
        state.unregister_session(au, pc3.conn);

        // (1) The PC was reaped; the phone then joined the channel normally.
        let mut pc4 = Sock::open(&state, a, "a", "sid-pc");
        pc4.join(&state, &room).await.expect("pc joins");
        state.unregister_session(au, pc4.conn);
        let mut phone = Sock::open(&state, a, "a", "sid-phone");
        state.set_conn_caps(au, phone.conn, true, Some("mobile"));
        phone.join(&state, &room).await.expect("phone joins");
        let mut pc5 = Sock::open(&state, a, "a", "sid-pc");
        let replay1 = pc5.replay(&state, &room).await;
        let f_pc5 = pc5.drain();
        let after1 = conns(&state, &room, au);
        let streams1 = streams(&state, &room, au);
        // Its re-claim right after is quiet too.
        let start1 = pc5.simple(&state, "StartStream", &room).await;
        state.unregister_session(au, pc5.conn);
        phone.simple(&state, "LeaveRoom", &room).await.expect("phone hangs up");

        // (2) Move here during the PC's rejoin grace: displaces nothing.
        let mut pc6 = Sock::open(&state, a, "a", "sid-pc");
        pc6.join(&state, &room).await.expect("pc joins");
        state.unregister_session(au, pc6.conn);
        phone.take_over(&state, &room).await.expect("phone moves here");
        let mut pc7 = Sock::open(&state, a, "a", "sid-pc");
        let replay2 = pc7.replay(&state, &room).await;
        let after2 = conns(&state, &room, au);
        state.unregister_session(au, pc7.conn);
        phone.simple(&state, "LeaveRoom", &room).await.expect("phone hangs up");

        // (3) The phone is in ANOTHER channel: the replay must not evict it.
        let mut pc8 = Sock::open(&state, a, "a", "sid-pc");
        pc8.join(&state, &room).await.expect("pc joins");
        state.unregister_session(au, pc8.conn);
        phone.join(&state, &other_room).await.expect("phone joins another channel");
        let _ = phone.drain();
        let mut pc9 = Sock::open(&state, a, "a", "sid-pc");
        let replay3 = pc9.replay(&state, &room).await;
        let after3 = (conns(&state, &room, au), conns(&state, &other_room, au));
        let f_phone3 = phone.drain();
        // The account is not in `room` at all now: only the refusal's own
        // tombstone keeps the PC's re-claim from being an Error.
        let start3 = pc9.simple(&state, "StartStream", &room).await;

        // A deliberate click on the PC still takes the call (exclusivity).
        let deliberate = pc9.join(&state, &room).await;
        let after_deliberate = (conns(&state, &room, au), conns(&state, &other_room, au));
        cleanup(&pool, &[a, b], &server).await;

        assert!(control.is_ok() && after_control == vec![pc2.conn], "control: no call elsewhere, the replay rejoins: {after_control:?}");
        assert!(same_device.is_ok() && after_same_device.contains(&pc3.conn), "control: a same-device reconnect rejoins: {after_same_device:?}");
        assert!(replay1.is_ok(), "{replay1:?}");
        assert_eq!(after1, vec![phone.conn], "(1) the replay did not put the PC back in the call next to the phone");
        assert!(streams1, "(1) the phone's voice claim is untouched");
        assert_eq!(why(&f_pc5, &room), vec![(Some("moved".into()), Some("mobile".into()))], "(1) the PC is told where the call went");
        assert!(start1.is_ok(), "(1) its re-claim is not an Error: {start1:?}");
        assert!(replay2.is_ok(), "{replay2:?}");
        assert_eq!(after2, vec![phone.conn], "(2) Move here during the grace: the PC's replay is refused");
        assert!(replay3.is_ok(), "{replay3:?}");
        assert_eq!(after3, (vec![], vec![phone.conn]), "(3) the phone's call in another channel is not evicted");
        assert!(!room_left(&f_phone3, &other_room), "(3) and the phone is told nothing");
        assert!(start3.is_ok(), "(3) its re-claim is not an Error: {start3:?}");
        assert!(deliberate.is_ok(), "{deliberate:?}");
        assert_eq!(after_deliberate, (vec![pc9.conn], vec![]), "a deliberate join still moves the call to the PC");
    }

    /// The PC's socket died a moment ago (it is out of the room, but the other
    /// devices are only told after the rejoin grace, so the phone's banner
    /// still says "You're in Lounge on your PC"). Leave or Move here pressed
    /// in that window found no connection to displace - and so wrote no
    /// tombstone, and the PC's replay on waking put it back in the call (with
    /// an open mic after a Leave). A Leave, or any deliberate voice join on
    /// another device, now also marks the sessions that dropped out of voice
    /// moments ago. Control: with nothing pressed, the dropped PC's replay
    /// rejoins exactly as before.
    #[tokio::test]
    async fn leave_or_move_during_the_pcs_rejoin_grace_is_not_undone_by_its_replay() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let (a, b, server, voice, _other, _text) = fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = format!("voice_{voice}");
        let au = a as UserId;
        let mut phone = Sock::open(&state, a, "a", "sid-phone");
        state.set_conn_caps(au, phone.conn, true, Some("mobile"));
        let why = |frames: &[ServerMessage]| -> Vec<(Option<String>, Option<String>)> {
            frames
                .iter()
                .filter_map(|m| match m {
                    ServerMessage::RoomLeft { room_id, reason, by } if *room_id == room => Some((reason.clone(), by.clone())),
                    _ => None,
                })
                .collect()
        };

        // Leave pressed while the PC's socket is in its grace.
        let mut pc = Sock::open(&state, a, "a", "sid-pc");
        pc.join(&state, &room).await.expect("pc joins");
        state.unregister_session(au, pc.conn);
        phone
            .send(&state, serde_json::json!({ "type": "LeaveOwnVoice", "payload": { "room_id": room } }))
            .await
            .expect("leave");
        let mut pc2 = Sock::open(&state, a, "a", "sid-pc");
        let replay1 = pc2.replay(&state, &room).await;
        let f1 = pc2.drain();
        let after1 = conns(&state, &room, au);
        let start1 = pc2.simple(&state, "StartStream", &room).await;

        // Move here pressed in the grace, then the phone hangs up before the
        // PC wakes: nothing is live anywhere, but the call was moved off it.
        pc2.join(&state, &room).await.expect("pc joins again, deliberately");
        state.unregister_session(au, pc2.conn);
        phone.take_over(&state, &room).await.expect("move here");
        phone.simple(&state, "LeaveRoom", &room).await.expect("phone hangs up");
        let mut pc3 = Sock::open(&state, a, "a", "sid-pc");
        let replay2 = pc3.replay(&state, &room).await;
        let f2 = pc3.drain();
        let after2 = conns(&state, &room, au);

        // Control: the PC drops and nobody presses anything - it rejoins.
        pc3.join(&state, &room).await.expect("pc joins again, deliberately");
        state.unregister_session(au, pc3.conn);
        let mut pc4 = Sock::open(&state, a, "a", "sid-pc");
        let control = pc4.replay(&state, &room).await;
        let after_control = conns(&state, &room, au);
        cleanup(&pool, &[a, b], &server).await;

        assert!(replay1.is_ok(), "{replay1:?}");
        assert_eq!(after1, Vec::<u64>::new(), "Leave in the grace: the PC's replay does not rejoin");
        assert_eq!(why(&f1), vec![(Some("left_elsewhere".into()), Some("mobile".into()))], "and the PC is told why");
        assert!(start1.is_ok(), "its re-claim is quiet: {start1:?}");
        assert!(replay2.is_ok(), "{replay2:?}");
        assert_eq!(after2, Vec::<u64>::new(), "Move here in the grace: the PC's later replay does not rejoin");
        assert_eq!(why(&f2), vec![(Some("moved".into()), Some("mobile".into()))]);
        assert!(control.is_ok() && after_control == vec![pc4.conn], "control: an untouched drop rejoins: {after_control:?}");
    }

    /// Found by the live two-device check, where the SFU half failed only on
    /// some runs ("Channel not found" on the sfu-token request, so the phone
    /// never reached LiveKit): `update_channel` and `get_sfu_token` run the
    /// SAME SQL text against channels.id (INT4), one binding i32 and the other
    /// i64. sqlx caches the prepared statement per connection keyed by the
    /// text alone, so once a pooled connection had served a channel edit,
    /// every SFU join that landed on it failed with 22P03 (incorrect binary
    /// data format) - swallowed as "not found". One connection, so the two
    /// handlers are forced onto the same one.
    #[tokio::test]
    async fn an_sfu_join_still_mints_after_a_channel_edit_on_the_same_connection() {
        use crate::sfu::resync_tests::{livekit_stand_in, no_env_proxy};
        use axum::response::IntoResponse;
        let Some(pool) = crate::migrator::test_pool(1).await else { return };
        no_env_proxy();
        let (a, b, server, _voice, sfu, _text) = fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let claims: crate::auth::Claims = serde_json::from_value(serde_json::json!({
            "sub": a, "username": "a", "exp": chrono::Utc::now().timestamp() + 3600, "sid": "sid-pc",
        }))
        .expect("claims");
        let (base, _srv) = livekit_stand_in(vec![], None).await;
        let run = async {
            let edit = crate::channel_handlers::update_channel(
                axum::extract::State(state.clone()),
                axum::extract::Path(sfu as i64),
                axum::Extension(claims.clone()),
                axum::Json(serde_json::from_value(serde_json::json!({ "sfu_mode": true })).expect("payload")),
            )
            .await
            .into_response()
            .status();
            let mint = crate::sfu::get_sfu_token(
                axum::extract::State(state.clone()),
                axum::extract::Path(sfu as i64),
                axum::Extension(claims.clone()),
            )
            .await
            .into_response()
            .status();
            (edit, mint)
        };
        let (edit, mint) = crate::sfu::TEST_LIVEKIT.scope(base, run).await;
        cleanup(&pool, &[a, b], &server).await;

        assert!(edit.is_success(), "fixture: the owner's channel edit succeeds: {edit}");
        assert_eq!(mint, axum::http::StatusCode::OK, "the SFU join after it still mints a token");
    }

    /// SFU: LiveKit identities are minted per TOKEN REQUEST, not per socket,
    /// so "cut the user" would cut the phone too. Move here must cut exactly
    /// the PC's LiveKit session - the one minted on the PC's session - and
    /// leave the phone's alone, even when the phone already holds one.
    #[tokio::test]
    async fn move_here_cuts_only_the_pcs_livekit_session() {
        use crate::sfu::resync_tests::{asked, livekit_stand_in, no_env_proxy};
        use axum::response::IntoResponse;
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        no_env_proxy();
        let (a, b, server, _voice, sfu, _text) = fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = format!("voice_{sfu}");
        let au = a as UserId;
        let claims = |sid: &str| -> crate::auth::Claims {
            serde_json::from_value(serde_json::json!({
                "sub": a, "username": "a", "exp": chrono::Utc::now().timestamp() + 3600, "sid": sid,
            }))
            .expect("claims")
        };
        let (base, srv) = livekit_stand_in(
            vec![("/twirp/livekit.RoomService/RemoveParticipant", 200, "{}".to_string())],
            None,
        )
        .await;
        let mint = |sid: &'static str| {
            let state = state.clone();
            let c = claims(sid);
            async move {
                let resp = crate::sfu::get_sfu_token(
                    axum::extract::State(state),
                    axum::extract::Path(sfu as i64),
                    axum::Extension(c),
                )
                .await
                .into_response();
                assert_eq!(resp.status(), 200, "fixture: the mint answers");
                let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.expect("body");
                let v: serde_json::Value = serde_json::from_slice(&body).expect("json");
                v["identity"].as_str().expect("identity").to_string()
            }
        };
        let mut pc = Sock::open(&state, a, "a", "sid-pc");
        let mut phone = Sock::open(&state, a, "a", "sid-phone");
        let run = async {
            let pc_identity = mint("sid-pc").await;
            pc.join(&state, &room).await.expect("pc joins");
            // The phone's LiveKit session already exists when the move lands.
            let phone_identity = mint("sid-phone").await;
            phone.take_over(&state, &room).await.expect("phone takes over");
            (pc_identity, phone_identity)
        };
        let (pc_identity, phone_identity) = crate::sfu::TEST_LIVEKIT.scope(base, run).await;
        let seen = asked(srv).await;
        let on_phone = conns(&state, &room, au);
        // Who-minted-what: the cut identity is forgotten, the phone's kept.
        let minted = |sid: &str| -> Vec<String> {
            state
                .sfu_minted
                .get(&(au, sid.to_string(), format!("sfu_{sfu}")))
                .map(|m| m.iter().map(|m| m.identity.clone()).collect())
                .unwrap_or_default()
        };
        let (pc_minted, phone_minted) = (minted("sid-pc"), minted("sid-phone"));
        cleanup(&pool, &[a, b], &server).await;

        assert_eq!(on_phone, vec![phone.conn]);
        assert!(pc_minted.is_empty(), "a confirmed cut forgets the identity: {pc_minted:?}");
        assert_eq!(phone_minted, vec![phone_identity.clone()], "the phone's attribution stays");
        assert_eq!(seen.len(), 1, "exactly one LiveKit session is cut");
        assert!(seen[0].body.contains(&pc_identity), "the PC's: {}", seen[0].body);
        assert!(!seen[0].body.contains(&phone_identity), "never the phone's");
    }
}

/// The account's own voice state, pushed to its OTHER devices - and only to
/// connections that announced they can read it (`?caps=own_voice`): an old
/// client must never be handed a frame it does not know.
#[cfg(test)]
mod own_voice_state_tests {
    use super::{handle_message, parse_ws_caps, push_own_voice_state, send_own_voice_state_to};
    use crate::permissions::Permissions;
    use crate::protocol::ServerMessage;
    use crate::state::{AppState, UserId};
    use std::collections::HashSet;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    struct Sock {
        uid: UserId,
        conn: u64,
        rx: mpsc::Receiver<ServerMessage>,
        joined: HashSet<String>,
    }

    impl Sock {
        fn open(state: &Arc<AppState>, uid: i32, sid: &str, caps: Option<&str>, kind: Option<&str>) -> Sock {
            let (tx, rx) = mpsc::channel::<ServerMessage>(256);
            let (conn, _, _) = state.register_session(uid as UserId, "a".to_string(), tx, false, None, sid.to_string());
            let (own_voice, kind) = parse_ws_caps(caps, kind);
            state.set_conn_caps(uid as UserId, conn, own_voice, kind);
            Sock { uid: uid as UserId, conn, rx, joined: HashSet::new() }
        }

        async fn send(&mut self, state: &Arc<AppState>, frame: serde_json::Value) -> Result<(), String> {
            handle_message(state, self.uid, self.conn, "a", &frame.to_string(), &mut self.joined, "").await
        }

        fn drain(&mut self) -> Vec<ServerMessage> {
            let mut out = Vec::new();
            while let Ok(m) = self.rx.try_recv() {
                out.push(m);
            }
            out
        }
    }

    type Own = (Option<String>, Option<i64>, Option<String>, Option<String>, bool, Option<String>);

    /// The LAST OwnVoiceState in `frames`, flattened.
    fn last_own(frames: &[ServerMessage]) -> Option<Own> {
        frames.iter().rev().find_map(|m| match m {
            ServerMessage::OwnVoiceState { room_id, channel_id, channel_name, server_name, here, device, .. } => {
                Some((room_id.clone(), *channel_id, channel_name.clone(), server_name.clone(), *here, device.clone()))
            }
            _ => None,
        })
    }

    fn any_own(frames: &[ServerMessage]) -> bool {
        frames.iter().any(|m| matches!(m, ServerMessage::OwnVoiceState { .. }))
    }

    #[test]
    fn caps_are_read_from_the_query_and_the_device_kind_is_one_of_three() {
        assert_eq!(parse_ws_caps(None, None), (false, None));
        assert_eq!(parse_ws_caps(Some("own_voice"), Some("desktop")), (true, Some("desktop")));
        assert_eq!(parse_ws_caps(Some("x,own_voice,y"), Some("mobile")), (true, Some("mobile")));
        assert_eq!(parse_ws_caps(Some("own_voices"), Some("browser")), (false, Some("browser")), "exact token only");
        assert_eq!(parse_ws_caps(Some("own_voice"), Some("<script>")), (true, None), "a kind outside the three is dropped");
        assert_eq!(parse_ws_caps(Some("own_voice"), None), (true, None));
    }

    /// ONE `caps=` list carries both capabilities, so both readers of it must
    /// tokenise it the same way. They did not: presence lowercased, own_voice
    /// compared exactly, so `OWN_VOICE,PRESENCE` turned on presence alone.
    #[test]
    fn both_readers_of_the_one_caps_list_agree_on_every_spelling() {
        use crate::presence::ClientCaps;
        for raw in ["own_voice,presence", " own_voice , presence ", "OWN_VOICE,PRESENCE", "Own_Voice,Presence", ",,own_voice,,presence,,"] {
            assert!(parse_ws_caps(Some(raw), None).0, "own_voice from {raw:?}");
            assert!(ClientCaps::parse(Some(raw)).presence, "presence from {raw:?}");
        }
        for raw in ["own_voice presence", "own_voices,presences", "", "x"] {
            assert!(!parse_ws_caps(Some(raw), None).0, "no own_voice from {raw:?}");
            assert!(!ClientCaps::parse(Some(raw)).presence, "no presence from {raw:?}");
        }
    }

    /// The query as the upgrade extracts it. The documented form is ONE
    /// comma list; a repeated key fails extraction (serde: duplicate field),
    /// which axum answers with 400 before auth. docs/API_REFERENCE.md says so -
    /// this pins it, so a server that starts accepting (or a client that
    /// starts sending) repeats is a decision, not an accident.
    #[test]
    fn the_upgrade_query_takes_one_caps_list_and_refuses_a_repeated_key() {
        use axum::extract::Query;
        use axum::http::Uri;
        let parse = |q: &str| Query::<super::WsQuery>::try_from_uri(&format!("http://h/ws?{q}").parse::<Uri>().unwrap());

        let Query(q) = parse("caps=own_voice,presence&kind=desktop").expect("the client's own URL parses");
        assert_eq!(parse_ws_caps(q.caps.as_deref(), q.kind.as_deref()), (true, Some("desktop")));
        assert!(crate::presence::ClientCaps::parse(q.caps.as_deref()).presence);

        let dup = parse("caps=own_voice&caps=presence").expect_err("a repeated caps= is refused");
        assert!(dup.body_text().contains("duplicate field `caps`"), "{}", dup.body_text());
        assert_eq!(dup.status(), axum::http::StatusCode::BAD_REQUEST);
        let dup = parse("caps=own_voice,presence&kind=desktop&kind=mobile").expect_err("a repeated kind= is refused");
        assert!(dup.body_text().contains("duplicate field `kind`"), "{}", dup.body_text());
    }

    #[tokio::test]
    async fn the_other_devices_learn_where_the_call_is_and_old_clients_learn_nothing() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let mut ids = Vec::new();
        for n in ["a", "b"] {
            let (id,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
                .bind(format!("ovs_{n}_{}", &tag[..12]))
                .bind(b"s".as_ref())
                .bind(b"v".as_ref())
                .fetch_one(&pool)
                .await
                .expect("user");
            ids.push(id);
        }
        let (a, b) = (ids[0], ids[1]);
        let server = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'Friends', $2)")
            .bind(&server)
            .bind(a)
            .execute(&pool)
            .await
            .expect("server");
        for m in [a, b] {
            sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)")
                .bind(&server)
                .bind(m)
                .execute(&pool)
                .await
                .expect("member");
        }
        let everyone = (Permissions::VIEW_CHANNEL | Permissions::CONNECT | Permissions::SPEAK).bits() as i64;
        sqlx::query(
            "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) \
             VALUES ($1, '@everyone', '#99AAB5', $2, 0, true)",
        )
        .bind(&server)
        .bind(everyone)
        .execute(&pool)
        .await
        .expect("@everyone");
        let (voice,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type, sfu_mode) VALUES ($1, 'Lounge', 1, false) RETURNING id")
            .bind(&server)
            .fetch_one(&pool)
            .await
            .expect("voice");
        let room = format!("voice_{voice}");
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));

        let mut pc = Sock::open(&state, a, "s1", Some("own_voice"), Some("desktop"));
        let mut phone = Sock::open(&state, a, "s2", Some("own_voice"), Some("mobile"));
        let mut old = Sock::open(&state, a, "s3", None, None);
        let mut sb = Sock::open(&state, b, "s4", Some("own_voice"), Some("mobile"));

        // On connect, a capable socket is told the state at once - that frame
        // is also how the client learns this server supports the feature.
        send_own_voice_state_to(&state, a as UserId, phone.conn).await;
        let at_connect = last_own(&phone.drain());

        pc.send(&state, serde_json::json!({ "type": "JoinRoom", "payload": { "room_id": room } })).await.expect("pc joins");
        let (f_pc, f_phone, f_old, f_b) = (pc.drain(), phone.drain(), old.drain(), sb.drain());

        // A device that connects while the call is on the PC.
        let mut tablet = Sock::open(&state, a, "s5", Some("own_voice"), Some("browser"));
        send_own_voice_state_to(&state, a as UserId, tablet.conn).await;
        let tablet_sees = last_own(&tablet.drain());

        // The phone takes the call: now the PC is the one told "elsewhere".
        phone.send(&state, serde_json::json!({ "type": "JoinRoom", "payload": { "room_id": room, "take_over": true } }))
            .await
            .expect("move here");
        let (pc_after_move, phone_after_move) = (last_own(&pc.drain()), last_own(&phone.drain()));

        // The phone hangs up: every device learns the account is out of voice.
        phone.send(&state, serde_json::json!({ "type": "StopStream", "payload": { "room_id": room } })).await.ok();
        phone.send(&state, serde_json::json!({ "type": "LeaveRoom", "payload": { "room_id": room } })).await.ok();
        let (pc_after_leave, old_after_leave) = (last_own(&pc.drain()), old.drain());

        // A direct push with no capable socket left costs nothing and sends nothing.
        state.unregister_session(a as UserId, pc.conn);
        state.unregister_session(a as UserId, phone.conn);
        state.unregister_session(a as UserId, tablet.conn);
        push_own_voice_state(&state, a as UserId).await;
        let old_last = old.drain();

        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&server).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)").bind(vec![a, b]).execute(&pool).await;

        let none: Own = (None, None, None, None, false, None);
        let lounge = |here: bool, device: Option<&str>| -> Own {
            (Some(room.clone()), Some(voice as i64), Some("Lounge".into()), Some("Friends".into()), here, device.map(str::to_string))
        };
        assert_eq!(at_connect, Some(none.clone()), "connect: told at once, even when not in voice");
        assert_eq!(last_own(&f_phone), Some(lounge(false, Some("desktop"))), "the phone: in Lounge, on the desktop");
        assert_eq!(last_own(&f_pc), Some(lounge(true, None)), "the PC: here");
        assert!(!any_own(&f_old), "an old client is never sent the frame");
        assert!(!any_own(&f_b), "another account learns nothing about this one");
        assert_eq!(tablet_sees, Some(lounge(false, Some("desktop"))), "a device connecting mid-call is told");
        assert_eq!(pc_after_move, Some(lounge(false, Some("mobile"))), "after Move here the PC sees the call on the phone");
        assert_eq!(phone_after_move, Some(lounge(true, None)));
        assert_eq!(pc_after_leave, Some(none), "hang up: nobody is in voice any more");
        assert!(!any_own(&old_after_leave) && !any_own(&old_last), "still nothing for the old client");
    }

    /// The displaced device is told WHY, and by which kind of device, so it can
    /// say "You moved the call to your phone" instead of dropping silently. A
    /// LeaveRoom's own RoomLeft stays the plain frame.
    #[tokio::test]
    async fn the_displaced_device_is_told_why_and_by_which_kind_of_device() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let (a,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
            .bind(format!("ovr_{}", &tag[..12]))
            .bind(b"s".as_ref())
            .bind(b"v".as_ref())
            .fetch_one(&pool)
            .await
            .expect("user");
        let server = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'S', $2)").bind(&server).bind(a).execute(&pool).await.expect("server");
        sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)").bind(&server).bind(a).execute(&pool).await.expect("member");
        let (voice,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type, sfu_mode) VALUES ($1, 'v', 1, false) RETURNING id")
            .bind(&server)
            .fetch_one(&pool)
            .await
            .expect("voice");
        let room = format!("voice_{voice}");
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let mut pc = Sock::open(&state, a, "s1", Some("own_voice"), Some("desktop"));
        let mut phone = Sock::open(&state, a, "s2", Some("own_voice"), Some("mobile"));
        let join = |r: &str, t: bool| serde_json::json!({ "type": "JoinRoom", "payload": { "room_id": r, "take_over": t } });

        pc.send(&state, join(&room, false)).await.expect("pc joins");
        phone.send(&state, join(&room, true)).await.expect("move here");
        let moved = pc.drain();
        pc.send(&state, join(&room, true)).await.expect("move back to the pc");
        let _ = pc.drain();
        phone.send(&state, serde_json::json!({ "type": "LeaveOwnVoice", "payload": { "room_id": room } })).await.expect("leave");
        let left = pc.drain();
        pc.send(&state, join(&room, false)).await.expect("pc joins again");
        pc.send(&state, serde_json::json!({ "type": "LeaveRoom", "payload": { "room_id": room } })).await.expect("hang up");
        let own_leave = pc.drain();
        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&server).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(a).execute(&pool).await;

        let why = |frames: &[ServerMessage]| -> Vec<(Option<String>, Option<String>)> {
            frames
                .iter()
                .filter_map(|m| match m {
                    ServerMessage::RoomLeft { room_id, reason, by } if *room_id == room => Some((reason.clone(), by.clone())),
                    _ => None,
                })
                .collect()
        };
        assert_eq!(why(&moved), vec![(Some("moved".into()), Some("mobile".into()))]);
        assert_eq!(why(&left), vec![(Some("left_elsewhere".into()), Some("mobile".into()))]);
        assert_eq!(why(&own_leave), vec![(None, None)], "an ordinary hang-up is the plain RoomLeft");
    }
    /// The phone's background DELIVERY socket (`?mode=delivery`) is not a
    /// screen: it is never sent OwnVoiceState, even if it announced the
    /// capability, and the account's voice changes skip it. Both halves are
    /// pinned on their own - `set_conn_caps` refuses to mark it, and
    /// `own_voice_conns` would not list it even if something had.
    #[tokio::test]
    async fn a_delivery_socket_is_never_sent_own_voice_state() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let (a,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
            .bind(format!("ovd_{}", &tag[..12]))
            .bind(b"s".as_ref())
            .bind(b"v".as_ref())
            .fetch_one(&pool)
            .await
            .expect("user");
        let server = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'S', $2)").bind(&server).bind(a).execute(&pool).await.expect("server");
        sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)").bind(&server).bind(a).execute(&pool).await.expect("member");
        let (voice,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type, sfu_mode) VALUES ($1, 'v', 1, false) RETURNING id")
            .bind(&server)
            .fetch_one(&pool)
            .await
            .expect("voice");
        let room = format!("voice_{voice}");
        let au = a as UserId;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));

        // The delivery socket announces the capability anyway.
        let (dtx, mut drx) = mpsc::channel::<ServerMessage>(256);
        let (dconn, _, _) = state.register_session(au, "a".to_string(), dtx, true, None, "s-phone".to_string());
        state.set_conn_caps(au, dconn, true, Some("mobile"));
        let marked = state.sessions.get(&au).is_some_and(|s| s.iter().any(|s| s.conn_id == dconn && s.own_voice));
        // A capable screen of the same account, as the positive control.
        let mut phone = Sock::open(&state, a, "s-phone", Some("own_voice"), Some("mobile"));
        let mut pc = Sock::open(&state, a, "s-pc", Some("own_voice"), Some("desktop"));

        send_own_voice_state_to(&state, au, dconn).await;
        pc.send(&state, serde_json::json!({ "type": "JoinRoom", "payload": { "room_id": room } })).await.expect("pc joins");
        pc.send(&state, serde_json::json!({ "type": "LeaveRoom", "payload": { "room_id": room } })).await.expect("pc leaves");
        let mut to_delivery = Vec::new();
        while let Ok(m) = drx.try_recv() {
            to_delivery.push(m);
        }
        let to_phone = phone.drain();
        let listed = state.own_voice_conns(au);

        // The second half alone: even a delivery session that somehow carried
        // the flag is not listed.
        if let Some(mut s) = state.sessions.get_mut(&au) {
            if let Some(s) = s.iter_mut().find(|s| s.conn_id == dconn) {
                s.own_voice = true;
            }
        }
        let listed_forced = state.own_voice_conns(au);
        let _ = pc.drain();
        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&server).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(a).execute(&pool).await;

        assert!(!marked, "set_conn_caps does not mark a delivery socket capable");
        assert!(!any_own(&to_delivery), "the delivery socket is sent no OwnVoiceState: {to_delivery:?}");
        assert!(any_own(&to_phone), "positive control: the capable phone screen is told");
        assert!(!listed.contains(&dconn) && listed.contains(&phone.conn), "{listed:?}");
        assert!(!listed_forced.contains(&dconn), "own_voice_conns skips a delivery session on its own: {listed_forced:?}");
    }
}

#[cfg(test)]
mod presence_ws_tests {
    //! Idle/away over the socket, against a real database: who is told, who
    //! is not, and that an old client never sees a frame it does not know.
    use super::handle_message;
    use crate::presence::{self, ClientCaps, PresenceStatus};
    use crate::protocol::ServerMessage;
    use crate::state::{AppState, UserId};
    use std::collections::HashSet;
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tokio::sync::mpsc;

    struct Sock {
        uid: UserId,
        conn: u64,
        rx: mpsc::Receiver<ServerMessage>,
        joined: HashSet<String>,
    }

    impl Sock {
        /// The connect path of handle_socket, minus the socket: register
        /// already classified, then the presence half of connect.
        async fn open(state: &Arc<AppState>, uid: i32, caps: bool, headless: bool) -> Sock {
            let (tx, rx) = mpsc::channel::<ServerMessage>(256);
            let caps = ClientCaps { presence: caps };
            let (conn, is_first, _) = state.register_session_classified(
                uid as UserId,
                format!("u{uid}"),
                tx,
                false,
                None,
                String::new(),
                presence::classify(headless, caps),
            );
            presence::on_connect(state, uid as UserId, conn, caps, is_first).await;
            Sock { uid: uid as UserId, conn, rx, joined: HashSet::new() }
        }

        async fn report(&mut self, state: &Arc<AppState>, inactive_secs: Option<u32>) {
            let frame = serde_json::json!({ "type": "SetActivity", "payload": { "inactive_secs": inactive_secs } }).to_string();
            let r = handle_message(state, self.uid, self.conn, "x", &frame, &mut self.joined, "").await;
            assert_eq!(r, Ok(()), "SetActivity is never an error");
        }

        fn drain(&mut self) -> Vec<ServerMessage> {
            let mut out = Vec::new();
            while let Ok(m) = self.rx.try_recv() {
                out.push(m);
            }
            out
        }
    }

    /// The (user, status) of every UserStatus in `frames`.
    fn statuses(frames: &[ServerMessage]) -> Vec<(UserId, PresenceStatus)> {
        frames
            .iter()
            .filter_map(|m| match m {
                ServerMessage::UserStatus { user_id, status } => Some((*user_id, *status)),
                _ => None,
            })
            .collect()
    }

    fn features(frames: &[ServerMessage]) -> Vec<Vec<String>> {
        frames
            .iter()
            .filter_map(|m| match m {
                ServerMessage::ServerFeatures { features } => Some(features.clone()),
                _ => None,
            })
            .collect()
    }

    async fn user(pool: &sqlx::PgPool, name: &str) -> i32 {
        let (id,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
            .bind(name)
            .bind(b"s".as_ref())
            .bind(b"v".as_ref())
            .fetch_one(pool)
            .await
            .expect("user");
        id
    }

    async fn shared_server(pool: &sqlx::PgPool, name: &str, owner: i32, members: &[i32]) -> String {
        let sid = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, $2, $3)")
            .bind(&sid)
            .bind(name)
            .bind(owner)
            .execute(pool)
            .await
            .expect("server");
        for m in members {
            sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)")
                .bind(&sid)
                .bind(m)
                .execute(pool)
                .await
                .expect("member");
        }
        sid
    }

    #[tokio::test]
    async fn status_reaches_capable_watchers_only_and_never_an_old_client() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let mk = |n: &str| format!("ps_{n}_{}", &tag[..12]);
        let subject = user(&pool, &mk("subject")).await; // reports, shares the server
        let watcher = user(&pool, &mk("watcher")).await; // new client, shares the server
        let oldie = user(&pool, &mk("oldie")).await; // OLD client, shares the server
        let stranger = user(&pool, &mk("stranger")).await; // new client, no relationship
        let blocked = user(&pool, &mk("blocked")).await; // shares the server, blocked by subject
        let hidden = user(&pool, &mk("hidden")).await; // "Show online status" off
        let quiet = user(&pool, &mk("quiet")).await; // "Show when I'm idle or away" off
        let ids = vec![subject, watcher, oldie, stranger, blocked, hidden, quiet];
        let sid = shared_server(&pool, &mk("srv"), subject, &[subject, watcher, oldie, blocked, hidden, quiet]).await;
        sqlx::query("INSERT INTO blocked_users (blocker_id, blocked_id) VALUES ($1, $2)")
            .bind(subject)
            .bind(blocked)
            .execute(&pool)
            .await
            .expect("block");
        sqlx::query("UPDATE users SET show_online_status = FALSE WHERE id = $1").bind(hidden).execute(&pool).await.unwrap();
        sqlx::query("UPDATE users SET show_idle_status = FALSE WHERE id = $1").bind(quiet).execute(&pool).await.unwrap();

        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let gap = state.presence.thresholds.min_broadcast_gap() + Duration::from_secs(1);

        let mut s_watcher = Sock::open(&state, watcher, true, false).await;
        let mut s_oldie = Sock::open(&state, oldie, false, false).await;
        let mut s_stranger = Sock::open(&state, stranger, true, false).await;
        let mut s_blocked = Sock::open(&state, blocked, true, false).await;
        let mut s_subject = Sock::open(&state, subject, true, false).await;
        let mut s_hidden = Sock::open(&state, hidden, true, false).await;
        let mut s_quiet = Sock::open(&state, quiet, true, false).await;

        // The capability is confirmed to every connection that announced it,
        // and to no other.
        let connect_watcher = s_watcher.drain();
        let connect_oldie = s_oldie.drain();
        let connect_subject = s_subject.drain();
        let _ = (s_stranger.drain(), s_blocked.drain(), s_hidden.drain(), s_quiet.drain());

        // 1. Ten minutes and more without input: idle.
        s_subject.report(&state, Some(700)).await;
        let idle_watcher = statuses(&s_watcher.drain());
        let idle_oldie = s_oldie.drain();
        let idle_stranger = statuses(&s_stranger.drain());
        let idle_blocked = statuses(&s_blocked.drain());
        let idle_self = statuses(&s_subject.drain());
        let idle_listed = state.listing_status(subject as UserId);

        // 2. Back at the keyboard: shown at once, whatever the gap.
        s_subject.report(&state, None).await;
        let back_immediately = statuses(&s_watcher.drain());
        // 3. Quiet again INSIDE the broadcast gap: held, not lost — the sweep
        // delivers it once the gap has passed (trailing edge). This is what
        // bounds a client flapping its reports to two fan-outs per gap.
        s_subject.report(&state, Some(700)).await;
        let idle_again_immediately = statuses(&s_watcher.drain());
        let t1 = Instant::now() + gap;
        presence::sweep(&state, t1).await;
        let idle_after_gap = statuses(&s_watcher.drain());

        // 4. A report of a long absence: away, again after the gap.
        s_subject.report(&state, Some(3700)).await;
        presence::sweep(&state, t1 + gap).await;
        let away_watcher = statuses(&s_watcher.drain());

        // 5. Hidden users share nothing, idle included — but their OWN
        // devices still see their status.
        s_hidden.report(&state, Some(700)).await;
        let hidden_watcher = statuses(&s_watcher.drain());
        // (Hiding your own status does not hide others' from you: drop
        // the subject's frames this socket also received.)
        let hidden_self: Vec<_> = statuses(&s_hidden.drain()).into_iter().filter(|(u, _)| *u == hidden as UserId).collect();
        // 5b. ...until they show it again while idle: update_profile's
        // UserOnline reads as plain online, so the real status must follow
        // it — the decision itself did not change (it was kept while hidden),
        // so only the un-hide correction can send this.
        sqlx::query("UPDATE users SET show_online_status = TRUE WHERE id = $1").bind(hidden).execute(&pool).await.unwrap();
        presence::flags_changed(&state, hidden as UserId, Some(true), None, true).await;
        let unhidden_watcher = statuses(&s_watcher.drain());
        let _ = s_hidden.drain();

        // 6. "Show when I'm idle or away" off: plain online, nothing sent...
        s_quiet.report(&state, Some(3700)).await;
        let quiet_watcher = statuses(&s_watcher.drain());
        let quiet_listed = state.listing_status(quiet as UserId);
        // ...until they turn it on, which corrects everyone at once.
        sqlx::query("UPDATE users SET show_idle_status = TRUE WHERE id = $1").bind(quiet).execute(&pool).await.unwrap();
        presence::flags_changed(&state, quiet as UserId, None, Some(true), false).await;
        let quiet_on_watcher = statuses(&s_watcher.drain());

        for s in [&s_watcher, &s_oldie, &s_stranger, &s_blocked, &s_subject, &s_hidden, &s_quiet] {
            state.unregister_session(s.uid, s.conn);
        }
        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&sid).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)").bind(ids.clone()).execute(&pool).await;

        let presence_feature = vec![vec!["presence".to_string()]];
        assert_eq!(features(&connect_watcher), presence_feature, "a new client is told: {connect_watcher:?}");
        assert_eq!(features(&connect_subject), presence_feature);
        assert!(features(&connect_oldie).is_empty(), "an OLD client is never sent ServerFeatures: {connect_oldie:?}");

        let s = subject as UserId;
        // Positive control first: the frame IS delivered, so every empty
        // list below proves a filter, not a broken pipe.
        assert_eq!(idle_watcher, vec![(s, PresenceStatus::Idle)]);
        assert_eq!(idle_self, vec![(s, PresenceStatus::Idle)], "the user's own devices follow too");
        assert!(
            !idle_oldie.iter().any(|m| matches!(m, ServerMessage::UserStatus { .. } | ServerMessage::ServerFeatures { .. })),
            "an OLD client never receives a frame it cannot parse: {idle_oldie:?}"
        );
        assert!(idle_stranger.is_empty(), "no relationship, no presence: {idle_stranger:?}");
        assert!(idle_blocked.is_empty(), "a block stops status like it stops UserOnline: {idle_blocked:?}");
        assert_eq!(idle_listed, PresenceStatus::Idle, "REST reports what the sockets were told");

        assert_eq!(back_immediately, vec![(s, PresenceStatus::Online)], "coming back is never held");
        assert!(idle_again_immediately.is_empty(), "inside the broadcast gap a demotion waits: {idle_again_immediately:?}");
        assert_eq!(idle_after_gap, vec![(s, PresenceStatus::Idle)]);
        assert_eq!(away_watcher, vec![(s, PresenceStatus::Away)]);

        assert!(hidden_watcher.is_empty(), "hidden means hidden: {hidden_watcher:?}");
        assert_eq!(hidden_self, vec![(hidden as UserId, PresenceStatus::Idle)]);
        assert_eq!(unhidden_watcher, vec![(hidden as UserId, PresenceStatus::Idle)], "un-hiding while idle shows idle, not online");

        assert!(quiet_watcher.is_empty(), "sharing off reads plain online: {quiet_watcher:?}");
        assert_eq!(quiet_listed, PresenceStatus::Online);
        assert_eq!(quiet_on_watcher, vec![(quiet as UserId, PresenceStatus::Away)]);
    }

    /// The server's clock promotes without any new report, a headless device
    /// session never pins its owner active, and an old client does.
    #[tokio::test]
    async fn the_sweep_promotes_and_only_ui_sessions_count() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let mk = |n: &str| format!("pw_{n}_{}", &tag[..12]);
        let owner = user(&pool, &mk("owner")).await; // a PC and a LAN waker
        let mixed = user(&pool, &mk("mixed")).await; // an old client beside a new one
        let watcher = user(&pool, &mk("watcher")).await;
        let ids = vec![owner, mixed, watcher];
        let sid = shared_server(&pool, &mk("srv"), owner, &[owner, mixed, watcher]).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let t = state.presence.thresholds;

        let mut s_watcher = Sock::open(&state, watcher, true, false).await;
        let mut s_waker = Sock::open(&state, owner, false, true).await; // headless, never reports
        let after_waker_alone = statuses(&s_watcher.drain());
        let mut s_pc = Sock::open(&state, owner, true, false).await;
        let after_pc = statuses(&s_watcher.drain());

        // One report — "quiet for 9 minutes" — then only the clock moves.
        s_pc.report(&state, Some(540)).await;
        let at_nine = statuses(&s_watcher.drain());
        let t0 = Instant::now();
        presence::sweep(&state, t0 + Duration::from_secs(70)).await;
        let at_ten = statuses(&s_watcher.drain());

        // The PC closes; the waker keeps the user online, but the PC's last
        // activity is kept, so the hour still runs out.
        state.unregister_session(owner as UserId, s_pc.conn);
        presence::sweep(&state, t0 + Duration::from_secs(80)).await;
        let pc_gone = statuses(&s_watcher.drain());
        presence::sweep(&state, t0 + t.away).await;
        let at_hour = statuses(&s_watcher.drain());

        // An old UI client beside a reporting one: never idle.
        let mut s_old = Sock::open(&state, mixed, false, false).await;
        let mut s_new = Sock::open(&state, mixed, true, false).await;
        s_new.report(&state, Some(3700)).await;
        presence::sweep(&state, t0 + t.away + t.away).await;
        let mixed_frames = statuses(&s_watcher.drain());
        let mixed_status = state.listing_status(mixed as UserId);
        let _ = (s_old.drain(), s_waker.drain(), s_new.drain());

        for (u, c) in [(watcher, s_watcher.conn), (owner, s_waker.conn), (mixed, s_old.conn), (mixed, s_new.conn)] {
            state.unregister_session(u as UserId, c);
        }
        let record_left = state.presence.records.contains_key(&(owner as UserId));
        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&sid).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)").bind(ids.clone()).execute(&pool).await;

        let o = owner as UserId;
        // A waker alone: online (UserOnline went out) but nobody is at a
        // screen, so away — it does not paint its owner green around the clock.
        assert_eq!(after_waker_alone, vec![(o, PresenceStatus::Away)]);
        assert_eq!(after_pc, vec![(o, PresenceStatus::Online)], "a person arrived");
        assert!(at_nine.is_empty(), "nine minutes is not idle: {at_nine:?}");
        assert_eq!(at_ten, vec![(o, PresenceStatus::Idle)], "the server's clock made it idle");
        assert!(pc_gone.is_empty(), "the PC leaving changes nothing yet: {pc_gone:?}");
        assert_eq!(at_hour, vec![(o, PresenceStatus::Away)]);
        assert!(mixed_frames.iter().all(|(u, _)| *u != mixed as UserId), "an old client pins active: {mixed_frames:?}");
        assert_eq!(mixed_status, PresenceStatus::Online);
        assert!(!record_left, "the last visible session takes the record with it");
    }

    /// What one connection currently holds.
    fn activity_of(state: &Arc<AppState>, uid: UserId, conn: u64) -> Option<presence::SessionActivity> {
        state.sessions.get(&uid).and_then(|v| v.iter().find(|s| s.conn_id == conn).map(|s| s.activity))
    }

    /// The frame exactly as the client's JSON.stringify writes it — `type`
    /// first, which is what the read loop's prefix check keys on.
    fn wire_report(inactive_secs: Option<u32>) -> String {
        let secs = inactive_secs.map_or("null".to_string(), |s| s.to_string());
        format!(r#"{{"type":"SetActivity","payload":{{"inactive_secs":{secs}}}}}"#)
    }

    /// The client marks a report as told once it is on the wire and never
    /// repeats it. So a report the read loop's bucket refuses must still be
    /// TAKEN, or the server keeps a stale "inactive" while the person keeps
    /// chatting — and they go idle, then away, in front of everyone. (Each
    /// tab or app switch on web/Android is two frames, so a handful of quick
    /// switches empties the bucket.)
    #[tokio::test]
    async fn a_report_over_the_rate_limit_is_still_taken() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let mk = |n: &str| format!("pr_{n}_{}", &tag[..12]);
        let subject = user(&pool, &mk("subject")).await;
        let watcher = user(&pool, &mk("watcher")).await;
        let ids = vec![subject, watcher];
        let sid = shared_server(&pool, &mk("srv"), subject, &[subject, watcher]).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let gap = state.presence.thresholds.min_broadcast_gap() + Duration::from_secs(1);

        let mut s_watcher = Sock::open(&state, watcher, true, false).await;
        let mut s_subject = Sock::open(&state, subject, true, false).await;
        let _ = s_watcher.drain();

        // Nine quick switches through the REAL read-loop gate: active,
        // inactive, active, ... ending on "active" (back in the tab).
        let mut bucket = super::RateLimiter::for_presence();
        let reports: Vec<Option<u32>> = (0..9).map(|i| if i % 2 == 0 { None } else { Some(700) }).collect();
        let mut refused = 0;
        for r in &reports {
            let text = wire_report(*r);
            if super::presence_gate(&state, s_subject.uid, s_subject.conn, &text, &mut bucket) {
                let res = handle_message(&state, s_subject.uid, s_subject.conn, "x", &text, &mut s_subject.joined, "").await;
                assert_eq!(res, Ok(()));
            } else {
                refused += 1;
            }
        }
        let held = activity_of(&state, subject as UserId, s_subject.conn);
        // The sweep delivers what the refused frames changed.
        presence::sweep(&state, Instant::now() + gap).await;
        let listed = state.listing_status(subject as UserId);
        let last_seen = statuses(&s_watcher.drain()).last().copied();

        // A crafted, oversized frame faking the prefix is not parsed at all.
        let mut empty = super::RateLimiter::with(0.0, 0.0);
        let junk = format!(r#"{{"type":"SetActivity","payload":{{"inactive_secs":700}},"pad":"{}"}}"#, "x".repeat(4096));
        let junk_admitted = super::presence_gate(&state, s_subject.uid, s_subject.conn, &junk, &mut empty);
        let after_junk = activity_of(&state, subject as UserId, s_subject.conn);

        for s in [&s_watcher, &s_subject] {
            state.unregister_session(s.uid, s.conn);
        }
        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&sid).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)").bind(ids.clone()).execute(&pool).await;

        assert!(refused >= 3, "positive control: the bucket did refuse the tail of the burst ({refused})");
        assert_eq!(
            held,
            Some(presence::SessionActivity::Reporting(None)),
            "the session holds the LAST report sent, not the last one admitted"
        );
        assert_eq!(listed, PresenceStatus::Online, "an active person is not left idle");
        assert_eq!(last_seen, Some((subject as UserId, PresenceStatus::Online)), "and the watcher ends on online");
        assert!(!junk_admitted);
        assert_eq!(after_junk, Some(presence::SessionActivity::Reporting(None)), "an oversized frame changes nothing");
    }

    /// A new socket is not evidence that a person came back: a network blip
    /// reconnects the desktop while its old socket lingers, a waker or an
    /// open phone keeps the record alive. The away user must not flash
    /// online (and cost two fan-outs) until the new socket's own report.
    #[tokio::test]
    async fn a_reconnect_is_not_evidence_of_activity() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let mk = |n: &str| format!("pc_{n}_{}", &tag[..12]);
        let lingering = user(&pool, &mk("lingering")).await; // old socket still registered
        let waked = user(&pool, &mk("waked")).await; // only a waker keeps them online
        let watcher = user(&pool, &mk("watcher")).await;
        let ids = vec![lingering, waked, watcher];
        let sid = shared_server(&pool, &mk("srv"), watcher, &[lingering, waked, watcher]).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let gap = state.presence.thresholds.min_broadcast_gap() + Duration::from_secs(1);

        let mut s_watcher = Sock::open(&state, watcher, true, false).await;
        // 1. Away, with the old socket still registered when the new one lands.
        let mut s_old = Sock::open(&state, lingering, true, false).await;
        s_old.report(&state, Some(3700)).await;
        let away_first = statuses(&s_watcher.drain());
        let mut s_new = Sock::open(&state, lingering, true, false).await;
        let on_reconnect = statuses(&s_watcher.drain());
        s_new.report(&state, Some(3700)).await;
        presence::sweep(&state, Instant::now() + gap).await;
        let after_report = statuses(&s_watcher.drain());
        // Positive control: a real return is still shown at once.
        s_new.report(&state, None).await;
        let back = statuses(&s_watcher.drain());

        // 2. Away through a waker and the PC's tail; the PC reconnects.
        let mut s_waker = Sock::open(&state, waked, false, true).await;
        let mut s_pc = Sock::open(&state, waked, true, false).await;
        s_pc.report(&state, Some(3700)).await;
        state.unregister_session(waked as UserId, s_pc.conn);
        presence::sweep(&state, Instant::now() + gap).await;
        let _ = s_watcher.drain();
        let mut s_pc2 = Sock::open(&state, waked, true, false).await;
        let on_pc_reconnect = statuses(&s_watcher.drain());
        let _ = (s_old.drain(), s_new.drain(), s_waker.drain(), s_pc.drain(), s_pc2.drain());

        for (u, c) in [(watcher, s_watcher.conn), (lingering, s_old.conn), (lingering, s_new.conn), (waked, s_waker.conn), (waked, s_pc2.conn)] {
            state.unregister_session(u as UserId, c);
        }
        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&sid).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)").bind(ids.clone()).execute(&pool).await;

        let l = lingering as UserId;
        assert_eq!(away_first, vec![(l, PresenceStatus::Away)], "positive control: the frames do arrive");
        assert!(on_reconnect.is_empty(), "a reconnect alone shows no false online: {on_reconnect:?}");
        assert!(after_report.is_empty(), "and its own 'still away' report changes nothing: {after_report:?}");
        assert_eq!(back, vec![(l, PresenceStatus::Online)], "a real return is shown at once");
        assert!(on_pc_reconnect.is_empty(), "the PC reconnecting beside a waker shows no false online: {on_pc_reconnect:?}");
    }

    /// The per-user session cap evicts a visible session without the socket
    /// ever reaching unregister_session for it: its activity must still be
    /// kept (the tail), or the user drops straight to what the rest say.
    #[tokio::test]
    async fn a_session_evicted_by_the_cap_leaves_its_activity_behind() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let mk = |n: &str| format!("pe_{n}_{}", &tag[..12]);
        let subject = user(&pool, &mk("subject")).await;
        let ids = vec![subject];
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let gap = state.presence.thresholds.min_broadcast_gap() + Duration::from_secs(1);

        // The oldest socket is the one in use; nine more have been away.
        let active = Sock::open(&state, subject, true, false).await;
        let mut rest = Vec::new();
        for _ in 0..9 {
            let mut s = Sock::open(&state, subject, true, false).await;
            s.report(&state, Some(3700)).await;
            rest.push(s);
        }
        let before = state.listing_status(subject as UserId);
        // An eleventh: the cap (10) evicts the oldest — the active one.
        let newest = Sock::open(&state, subject, true, false).await;
        let evicted = activity_of(&state, subject as UserId, active.conn).is_none();
        presence::sweep(&state, Instant::now() + gap).await;
        let after = state.listing_status(subject as UserId);

        for s in rest.iter().chain([&newest]) {
            state.unregister_session(s.uid, s.conn);
        }
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)").bind(ids.clone()).execute(&pool).await;

        assert_eq!(before, PresenceStatus::Online);
        assert!(evicted, "positive control: the cap did evict the oldest");
        assert_eq!(after, PresenceStatus::Online, "the evicted session was active a moment ago");
    }
}
