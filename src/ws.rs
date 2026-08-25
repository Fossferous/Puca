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
    pub token: String,
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
}

/// WebSocket upgrade handler
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<WsQuery>,
    headers: axum::http::HeaderMap,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // Validate JWT token before upgrading
    match validate_token(&query.token, &state.jwt_secret) {
        Ok(claims) => {
            // M1 revocation: reject a token whose `tv` no longer matches the
            // user's token_version (logout / password change / recovery reset).
            let current_tv: Option<(i32,)> =
                sqlx::query_as("SELECT token_version FROM users WHERE id = $1")
                    .bind(claims.sub as i32)
                    .fetch_optional(&state.pool)
                    .await
                    .unwrap_or(None);
            match current_tv {
                Some((tv,)) if tv == claims.tv => {}
                _ => {
                    tracing::warn!(
                        "WS upgrade refused: stale/invalid token_version for user {}",
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
            ws.max_message_size(256 * 1024)
                .max_frame_size(256 * 1024)
                .on_upgrade(move |socket| {
                    handle_socket(socket, state, claims, ip_guard, delivery, claimed_device)
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

    // Register session (conn_id lets the disconnect path remove exactly this
    // connection; is_first tells us whether to announce the user online —
    // "first" meaning first VISIBLE connection; a delivery socket never is).
    let (conn_id, is_first_session, kill) =
        state.register_session(user_id, username.clone(), tx, delivery, claimed_device);

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
        for msg in state.drain_undelivered(user_id) {
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
        state.deliver_parked_offers(user_id, conn_id)
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

    // Cleanup on disconnect
    tracing::info!("User {} ({}) disconnected", username, user_id);
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
}

/// Does this user want their presence visible to others? Fails open to
/// visible (the column default) on a DB error — presence is not worth
/// breaking a connect over.
pub(crate) async fn user_shows_online(state: &Arc<AppState>, user_id: UserId) -> bool {
    // i32, matching handlers.rs's copy of this exact SQL text (users.id is
    // INT4) — see the 22P03 note in device_token.rs.
    sqlx::query_as::<_, (bool,)>("SELECT show_online_status FROM users WHERE id = $1")
        .bind(user_id as i32)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten()
        .map(|(b,)| b)
        .unwrap_or(true)
}

/// Which of `ids` have presence hidden (`show_online_status = false`)? One
/// query for the whole set — the per-user `user_shows_online` would be an N+1
/// against a room roster. Fails CLOSED to "nobody is hidden" on a DB error, the
/// same direction as `user_shows_online`: presence visibility is the column
/// default, and a transient error must not silently blank out every roster.
async fn hidden_members(
    state: &Arc<AppState>,
    ids: &[UserId],
) -> std::collections::HashSet<UserId> {
    if ids.is_empty() {
        return std::collections::HashSet::new();
    }
    sqlx::query_as::<_, (i64,)>(
        // id is INT4 but `ids` binds as bigint[]; cast to match, mirroring the
        // proven `id::bigint = ANY($2)` pattern in broadcast_perms_changed_and_evict.
        "SELECT id::bigint FROM users WHERE id::bigint = ANY($1) AND show_online_status = FALSE",
    )
    .bind(ids)
    .fetch_all(&state.pool)
    .await
    .map(|rows| rows.into_iter().map(|(id,)| id).collect())
    .unwrap_or_default()
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
        ) t",
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
    let (was_sharer, was_camera, members) = {
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
    state.send_to_user(
        user_id,
        match notice {
            SelfNotice::Gone => ServerMessage::RoomLeft {
                room_id: room_id.to_string(),
            },
            SelfNotice::MoveTo {
                server_id,
                channel_id,
                from_channel_id,
                moved_by,
            } => ServerMessage::VoiceMoved {
                server_id,
                channel_id,
                from_channel_id,
                moved_by,
            },
        },
    );

    // Authoritative media cut for moderation (see `cut_sfu` above). Still runs
    // unconditionally: the directive above is advisory — a client that ignores
    // it, or whose socket is already dead, is exactly the one whose LiveKit
    // publication has to be severed server-side.
    if cut_sfu {
        if let Some(cid) = parse_voice_room(room_id) {
            crate::sfu::evict_user_from_channel(state, cid, user_id).await;
        }
    }
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
    let mut expired: Vec<(String, UserId, UserId, bool, bool)> = Vec::new();
    state.file_transfers.retain(|id, t| {
        let ttl = if t.accepted {
            TRANSFER_IDLE_TTL_SECS
        } else {
            TRANSFER_OFFER_TTL_SECS
        };
        let alive = now.duration_since(t.touched_at).as_secs() < ttl;
        if !alive {
            expired.push((id.clone(), t.from, t.to, t.accepted, t.parked_offer.is_some()));
        }
        alive
    });

    for (transfer_id, from, to, accepted, parked) in expired {
        let reason = if accepted {
            "the transfer went quiet and timed out".to_string()
        } else if parked {
            // The offer never reached them at all — a different fact from
            // "they saw it and ignored it", and the sender should know which.
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
    if let Some(cid) = parse_voice_room(room_id) {
        return matches!(
            get_user_channel_permissions(&state.pool, cid, user_id).await,
            ChannelPermAccess::Allowed { perms, .. }
                if perms.has(Permissions::VIEW_CHANNEL)
                    && extra.is_none_or(|bit| perms.has(bit))
        );
    }
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

        ClientMessage::JoinRoom { room_id } => {
            // Bound room_id length and the number of rooms this connection may
            // join — otherwise a flood of unique room_ids grows the global rooms
            // DashMap without limit (one authenticated socket → OOM).
            if room_id.len() > MAX_ROOM_ID_LEN {
                return Err("room_id too long".to_string());
            }
            if !joined_rooms.contains(&room_id) && joined_rooms.len() >= MAX_ROOMS_PER_CONN {
                return Err("too many joined rooms".to_string());
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
            if let Some(cid) = parse_channel_room(&room_id).or_else(|| parse_voice_room(&room_id)) {
                // A VOICE room additionally requires CONNECT: it is an editable
                // role bit ("Join voice channels") that nothing enforced, so a
                // member explicitly denied CONNECT could still join the call.
                // Text rooms need VIEW only — CONNECT is a voice permission.
                let need_connect = parse_voice_room(&room_id).is_some();
                let allowed = matches!(
                    get_user_channel_permissions(&state.pool, cid, user_id).await,
                    ChannelPermAccess::Allowed { perms, .. }
                        if perms.has(Permissions::VIEW_CHANNEL)
                            && (!need_connect || perms.has(Permissions::CONNECT))
                );
                if !allowed {
                    // Warn-level: a legitimate client rejoining after reconnect
                    // that lands here is silently cut off from live channel
                    // traffic — this must be visible in prod logs.
                    tracing::warn!(
                        "JoinRoom rejected for user {} ({}): no VIEW/CONNECT access for room {}",
                        user_id,
                        username,
                        room_id
                    );
                    return Err("Not a member of this channel's server".to_string());
                }
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
                        SelfNotice::Gone,
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

            // Was the user already in the room from another device? Peers only
            // get a UserJoined for the user's FIRST joined connection.
            let already_member = state
                .rooms
                .get(&room_id)
                .map(|r| r.members.contains(&user_id))
                .unwrap_or(false);

            joined_rooms.insert(room_id.clone());
            state.join_room(&room_id, user_id, conn_id);

            // Close the check/insert race with a perms-change eviction pass:
            // the VIEW check above and the join_room insert are separated by
            // awaits, so a join that passed pre-commit could land AFTER the
            // eviction snapshot and keep a live subscription. Overwrites are
            // committed before eviction runs, so re-checking after the insert
            // is guaranteed to see any deny this join raced against.
            if let Some(cid) = parse_channel_room(&room_id).or_else(|| parse_voice_room(&room_id)) {
                let still_allowed = matches!(
                    get_user_channel_permissions(&state.pool, cid, user_id).await,
                    ChannelPermAccess::Allowed { perms, .. } if perms.has(Permissions::VIEW_CHANNEL)
                );
                if !still_allowed {
                    if let Some(mut room) = state.rooms.get_mut(&room_id) {
                        room.remove_member(user_id);
                    }
                    state.drop_room_if_empty(&room_id);
                    joined_rooms.remove(&room_id);
                    tracing::warn!(
                        "JoinRoom revoked post-insert for user {} ({}): VIEW lost for room {}",
                        user_id,
                        username,
                        room_id
                    );
                    return Err("Not a member of this channel's server".to_string());
                }
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
            }

            tracing::info!("User {} joined room {}", username, room_id);
        }

        ClientMessage::LeaveRoom { room_id } => {
            joined_rooms.remove(&room_id);
            state.leave_room(&room_id, user_id, conn_id);

            // Notify the leaving connection
            state.send_to_conn(
                user_id,
                conn_id,
                ServerMessage::RoomLeft {
                    room_id: room_id.clone(),
                },
            );

            // Notify other room members only when the user has fully left —
            // another of their devices may still be in the room. Mirrors the
            // JoinRoom gate: a presence-hidden user was never announced outside
            // voice, so their departure is not announced either.
            let still_member = state
                .rooms
                .get(&room_id)
                .map(|r| r.members.contains(&user_id))
                .unwrap_or(false);
            let announce_presence =
                room_announces_presence(&room_id) || user_shows_online(&state, user_id).await;
            if !still_member && announce_presence {
                state.broadcast_to_room(
                    &room_id,
                    ServerMessage::UserLeft {
                        room_id: room_id.clone(),
                        user_id,
                    },
                    None,
                );
            }

            tracing::info!("User {} left room {}", username, room_id);
        }

        ClientMessage::ChatMessage { room_id, content } => {
            // Length-cap content the same way the DM path does. Without this, a
            // single WS ChatMessage could carry a huge string that is then
            // CLONED to every room member (N× amplification). Empty and
            // NUL-bearing content are rejected too.
            if !valid_message_content(&content) {
                return Err("Invalid message content".to_string());
            }
            // Message send into a text-channel room requires VIEW + SEND: a
            // non-member (incl. a kicked user with a live token) or a member
            // who is VIEW- or SEND-denied on the channel must not inject a live
            // message. One generic error for every denial so the channel's
            // existence isn't leaked.
            if let Some(cid) = parse_channel_room(&room_id) {
                let allowed = matches!(
                    get_user_channel_permissions(&state.pool, cid, user_id).await,
                    ChannelPermAccess::Allowed { perms, .. }
                        if perms.has(Permissions::VIEW_CHANNEL)
                            && perms.has(Permissions::SEND_MESSAGES)
                );
                if !allowed {
                    return Err("Not a member of this channel's server".to_string());
                }
                // Member-timeout enforcement, mirroring the REST send path
                // (message_handlers.rs). Without it a timed-out member could
                // still inject a live, visible ChatMessage over the socket —
                // making the timeout advisory on this path. Scoped to the
                // server that owns this channel via the join.
                let timed_out: Option<(i32,)> = sqlx::query_as(
                    "SELECT 1 FROM member_timeouts mt \
                     JOIN channels c ON c.server_id = mt.server_id \
                     WHERE c.id = $1 AND mt.user_id = $2 AND mt.expires_at > NOW() LIMIT 1",
                )
                .bind(cid)
                .bind(user_id as i32)
                .fetch_optional(&state.pool)
                .await
                .unwrap_or(None);
                if timed_out.is_some() {
                    return Err("You are timed out in this server".to_string());
                }
            }
            // Defense-in-depth: gate voice-room (voice_<id>) ChatMessages too, so
            // a non-member can't inject a __VOICE_STATUS__ ping into a voice room
            // they never joined. VIEW only (join-level gate) — these are voice
            // status pings, not messages, so SEND_MESSAGES doesn't apply.
            if let Some(cid) = parse_voice_room(&room_id) {
                let allowed = matches!(
                    get_user_channel_permissions(&state.pool, cid, user_id).await,
                    ChannelPermAccess::Allowed { perms, .. } if perms.has(Permissions::VIEW_CHANNEL)
                );
                if !allowed {
                    return Err("Not a member of this channel's server".to_string());
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
            if !can_mutate_room_with(state, &room_id, user_id, Some(Permissions::STREAM)).await {
                return Err("Not in this room".to_string());
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
            // Non-member stop = silent no-op (see StopStream above).
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
            // bit that nothing checked until now.
            if !can_mutate_room_with(state, &room_id, user_id, Some(Permissions::VIDEO)).await {
                return Err("Not in this room".to_string());
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
            // Non-member stop = silent no-op (see StopStream above).
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
            let row: Option<(String,)> = sqlx::query_as(
                "SELECT sign_pub FROM devices \
                 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
            )
            .bind(&device_id)
            .bind(user_id as i32)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| e.to_string())?;

            let Some((sign_pub,)) = row else {
                tracing::debug!("device attest: unknown/revoked device {}", device_id);
                return Ok(());
            };

            if verify_device_attestation(&sign_pub, device_nonce, user_id, &sig) {
                state.attest_device(user_id, conn_id, device_id.clone());
                // A parked offer PINNED to this device could not match until
                // the id was proven; sweep again now that it is.
                let parked = state.deliver_parked_offers(user_id, conn_id);
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
            .map_err(|e| e.to_string())?;
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
                },
            );
            if parked {
                let reason = if to_self && target_device.is_some() {
                    "that device isn't connected — the offer will reach it when Puca opens there (it expires in about 2 minutes)"
                } else if to_self {
                    "your other device isn't connected — the offer will reach it when Puca opens there (it expires in about 2 minutes)"
                } else {
                    "their app isn't connected right now — the offer will reach them when they open Puca (it expires in about 2 minutes)"
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
                transfer_id,
                name,
                size,
                mime,
                sha256,
                auth,
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
            }
        }

        ClientMessage::FileAccept {
            transfer_id,
            resume_from,
        } => {
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
            let blocked: Option<(i32,)> = sqlx::query_as(
                "SELECT 1 FROM blocked_users \
                 WHERE (blocker_id = $1 AND blocked_id = $2) \
                    OR (blocker_id = $2 AND blocked_id = $1)",
            )
            .bind(user_id as i32)
            .bind(to_user_id as i32)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
            if blocked.is_some() {
                return Err("You cannot message this user".to_string());
            }

            // Same parity for the friends-only DM privacy flag: the Settings
            // toggle is enforced here because THIS is the path DMs travel.
            if !crate::dm_handlers::recipient_accepts_dms(&state, user_id, to_user_id).await {
                return Err("This user only accepts direct messages from friends".to_string());
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
                crate::wake::sender::wake_user(&state, to_user_id);
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

/// After any permission-affecting change in `server_id` (channel overwrite
/// created/updated/deleted, role permissions edited, member roles changed):
/// 1) broadcast ChannelPermsChanged to every server member (same fan-out
///    pattern as ChannelCreated in create_channel) so clients refetch their
///    channel list / my_permissions, and
/// 2) evict now-VIEW-denied users from this server's live in-memory rooms
///    (channel_<id> / voice_<id>) — otherwise a freshly hidden channel keeps
///    streaming to members who could no longer join it.
pub async fn broadcast_perms_changed_and_evict(state: &Arc<AppState>, server_id: &str) {
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
    if snapshot.is_empty() {
        return;
    }

    // Restrict to rooms whose channel belongs to THIS server (one query).
    let candidate_ids: Vec<i64> = snapshot.iter().map(|(_, cid, _)| *cid).collect();
    let in_server: std::collections::HashSet<i64> = match sqlx::query_as::<_, (i32,)>(
        "SELECT id FROM channels WHERE server_id = $1 AND id::bigint = ANY($2)",
    )
    .bind(server_id)
    .bind(&candidate_ids)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows.into_iter().map(|(id,)| id as i64).collect(),
        Err(e) => {
            tracing::error!(
                "broadcast_perms_changed_and_evict: channel scope query failed for server {}: {}",
                server_id,
                e
            );
            return;
        }
    };

    // Re-run the resolver per (channel, member), cached — a user sitting in both
    // channel_<id> and voice_<id> resolves once.
    let mut allowed_cache: std::collections::HashMap<(i64, UserId), bool> =
        std::collections::HashMap::new();
    for (room_id, cid, room_members) in snapshot {
        if !in_server.contains(&cid) {
            continue;
        }
        for member_id in room_members {
            let allowed = match allowed_cache.get(&(cid, member_id)) {
                Some(&ok) => ok,
                None => {
                    let ok = matches!(
                        get_user_channel_permissions(&state.pool, cid, member_id).await,
                        ChannelPermAccess::Allowed { perms, .. }
                            if perms.has(Permissions::VIEW_CHANNEL)
                    );
                    allowed_cache.insert((cid, member_id), ok);
                    ok
                }
            };
            if allowed {
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
        }
    }

    // 3) SFU rooms live in a SEPARATE map (state.sfu_rooms), not state.rooms, so
    // the mesh loop above never touches them. Force-evict any VIEW-denied user
    // from the LiveKit room too — otherwise a kicked/banned/role-stripped member
    // keeps publishing+subscribing media on the SFU path until they leave, and
    // the media key doesn't rotate away from them. Eviction also fires
    // ParticipantDisconnected on remaining clients → immediate epoch re-key.
    let sfu_targets: Vec<(i64, i64)> = {
        let mut out = Vec::new();
        for r in state.sfu_rooms.iter() {
            let Some(cid) = crate::sfu::channel_id_from_room(r.key()) else {
                continue;
            };
            if !in_server.contains(&cid) {
                continue;
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
    for (cid, uid) in sfu_targets {
        let allowed = match allowed_cache.get(&(cid, uid)) {
            Some(&ok) => ok,
            None => {
                let ok = matches!(
                    get_user_channel_permissions(&state.pool, cid, uid).await,
                    ChannelPermAccess::Allowed { perms, .. } if perms.has(Permissions::VIEW_CHANNEL)
                );
                allowed_cache.insert((cid, uid), ok);
                ok
            }
        };
        if allowed {
            continue;
        }
        crate::sfu::evict_user_from_channel(state, cid, uid).await;
        tracing::info!(
            "SFU perms eviction: user {} removed from sfu channel {} (VIEW denied, server {})",
            uid,
            cid,
            server_id
        );
    }
}

/// Helper function to create a JWT token (for login endpoint). `token_version`
/// is the user's current users.token_version — stamped into the `tv` claim so a
/// later bump (logout / password change / recovery reset) invalidates this token.
pub fn create_token(
    user_id: UserId,
    username: &str,
    token_version: i32,
    secret: &str,
) -> Result<String, String> {
    // A real sign-in starts a new session clock.
    create_token_with_start(
        user_id,
        username,
        token_version,
        Utc::now().timestamp(),
        secret,
    )
}

/// Mint a token that inherits an EXISTING session start (`sst`). Used by the
/// sliding-renewal path so extending a session never resets its absolute cap.
pub fn create_token_with_start(
    user_id: UserId,
    username: &str,
    token_version: i32,
    session_start: i64,
    secret: &str,
) -> Result<String, String> {
    use jsonwebtoken::{encode, EncodingKey, Header};

    let expiration = Utc::now()
        .checked_add_signed(chrono::Duration::hours(crate::auth::TOKEN_TTL_HOURS))
        .expect("valid timestamp")
        .timestamp();

    let claims = Claims {
        sub: user_id,
        username: username.to_string(),
        exp: expiration,
        tv: token_version,
        sst: session_start,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| format!("Token creation failed: {}", e))
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
