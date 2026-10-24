//! The web app's push subscription, and what its service worker may ask.
//!
//! The transport and its contract live in `wake/webpush.rs` (a constant over
//! the push service, nothing else); WHEN a wake is sent lives in
//! `wake/sender.rs`. This module is the HTTP surface around them:
//!
//! - `POST /push/web/subscription` (signed in): a browser turned on
//!   "Notifications on this device". Stores its PushSubscription, the session
//!   that made it (so signing that session out stops its pushes), this
//!   device's mutes and blocks, and the hash of a fresh random secret that
//!   only that browser's service worker keeps.
//! - `PATCH /push/web/subscription`: the device's mutes or blocks changed (and
//!   at every app start, which also rebinds the row to the current session:
//!   signing in again mints a new one).
//! - `DELETE /push/web/subscription`: turned off, or signing out.
//! - `POST /push/web/test`: push to THIS session's browser, now.
//! - `GET /push/web/key` (public): the VAPID public key, or null.
//! - `POST /push/web/pending` (public, the worker's secret instead of a
//!   session): what knocked. Answers with the content-free titles the
//!   Android app shows ("alice sent you a message" / "New message"), built
//!   from the notification frames logged for its user since this browser was
//!   last open and since its worker last asked (`AppState::web_push_unseen`),
//!   filtered by this browser's own mutes and blocks. NEVER message content: a
//!   DirectMessage frame carries ciphertext, and this module does not read
//!   that field.
//!
//! WHY A SECRET AND NOT THE SESSION TOKEN. A service worker runs with the page
//! closed and cannot read the page's storage, so whatever it authenticates
//! with must be written somewhere it CAN read (IndexedDB) — on disk. A session
//! token there would be a full sign-in sitting beside the push code; this
//! secret can read the titles of what is parked for its own user and nothing
//! else, dies with its subscription, and the subscription dies with the
//! session (`sender::live_subscriptions`).

use axum::{
    extract::{Extension, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::auth::Claims;
use crate::protocol::ServerMessage;
use crate::state::{AppState, UserId};
use crate::wake::sender::WebGates;
use crate::wake::webpush::{endpoint_allowed, WebPushTarget};

/// The body of every message notification — never content-derived. Same
/// literal as PushFrames.java's GENERIC_BODY and desktopNotify.ts.
pub const GENERIC_BODY: &str = "New message";
/// The clip consent doorbell. src/protocol.rs pins these two literals across
/// PushFrames.java and clipProposals.ts; this is the fourth copy, pinned by
/// the test below.
pub const CLIP_TITLE: &str = "Approval needed";
pub const CONSENT_BODY: &str = "Open Púca to approve or decline";

/// A browser that cannot tell the worker what knocked shows this. Mirrored in
/// frontend/public/sw.js.
pub const GENERIC_TITLE: &str = "Púca";
pub const GENERIC_ACTIVITY: &str = "New activity in Púca";

/// Per user. More than this and the oldest go: a person does not have twenty
/// browsers, and an unbounded table is a way to make every wake slow.
const MAX_SUBSCRIPTIONS_PER_USER: i64 = 20;
/// Per gate list. Generous (a user muting thousands of channels is still
/// fine) and bounded.
const MAX_GATE_ENTRIES: usize = 5000;
/// How many notifications one wake may show.
const MAX_ITEMS: usize = 4;

#[derive(Debug, Default, Deserialize)]
pub struct GatesBody {
    #[serde(default)]
    pub muted_servers: Vec<String>,
    #[serde(default)]
    pub muted_channels: Vec<i64>,
    #[serde(default)]
    pub blocked_ids: Vec<i64>,
}

impl GatesBody {
    fn checked(self) -> Result<WebGates, &'static str> {
        if self.muted_servers.len() > MAX_GATE_ENTRIES
            || self.muted_channels.len() > MAX_GATE_ENTRIES
            || self.blocked_ids.len() > MAX_GATE_ENTRIES
        {
            return Err("too many mutes or blocks");
        }
        if self.muted_servers.iter().any(|s| s.len() > 64) {
            return Err("a server id is too long");
        }
        Ok(WebGates {
            muted_servers: self.muted_servers,
            muted_channels: self.muted_channels,
            blocked_ids: self.blocked_ids,
        })
    }
}

#[derive(Debug, Deserialize)]
pub struct SubscribeRequest {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    #[serde(default)]
    pub gates: GatesBody,
}

#[derive(Debug, Serialize)]
pub struct SubscribeResponse {
    pub id: i64,
    /// Handed to the browser once and stored only as its SHA-256.
    pub secret: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateGatesRequest {
    pub id: i64,
    #[serde(default)]
    pub gates: GatesBody,
}

#[derive(Debug, Deserialize)]
pub struct UnsubscribeRequest {
    pub endpoint: String,
}

#[derive(Debug, Deserialize)]
pub struct PendingRequest {
    pub id: i64,
    pub secret: String,
}

/// One notification the worker shows.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PendingItem {
    /// Collapse key — the same 'chan:<server>' / 'dm:<conversation>' /
    /// 'clip:<id>' the Android and in-app paths use.
    pub tag: String,
    pub title: String,
    pub body: String,
    /// Where a tap lands — Chat.tsx's nav targets.
    pub nav: String,
}

fn secret_hash(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

fn bad(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, msg.into()).into_response()
}

/// A display name fit for a lock screen: no control characters, bounded.
fn display(name: &str) -> String {
    let clean: String = name.chars().filter(|c| !c.is_control()).take(64).collect();
    if clean.trim().is_empty() {
        "Someone".to_string()
    } else {
        clean
    }
}

/// What knocked, newest first: the parked frames (oldest first, as
/// `peek_undelivered` returns them) turned into notifications for THIS
/// browser. The Android parser's rules (PushFrames.java + PushGate.java): own
/// frames never notify, a blocked author never notifies (except a clip
/// prompt, which names nobody), a muted server or channel never notifies, one
/// notification per conversation, and a DirectMessage's `content` is never
/// read.
pub fn pending_items(frames: &[ServerMessage], me: UserId, gates: &WebGates) -> Vec<PendingItem> {
    let mut out: Vec<PendingItem> = Vec::new();
    for frame in frames.iter().rev() {
        let item = match frame {
            ServerMessage::MessageNotification { server_id, channel_id, author, .. } => {
                if author.id == me
                    || gates.blocked_ids.contains(&author.id)
                    || gates.muted_servers.iter().any(|s| s == server_id)
                    || gates.muted_channels.contains(channel_id)
                {
                    continue;
                }
                PendingItem {
                    tag: format!("chan:{server_id}"),
                    title: format!("{} sent a message", display(&author.username)),
                    body: GENERIC_BODY.into(),
                    nav: format!("server:{server_id}"),
                }
            }
            // `content` is deliberately not bound: it is ciphertext, and even
            // decrypted it would not belong on a lock screen.
            ServerMessage::DirectMessage { conversation_id, sender, .. } => {
                if sender.id == me || gates.blocked_ids.contains(&sender.id) {
                    continue;
                }
                PendingItem {
                    tag: format!("dm:{conversation_id}"),
                    title: format!("{} sent you a message", display(&sender.username)),
                    body: GENERIC_BODY.into(),
                    nav: format!("dm:{conversation_id}"),
                }
            }
            ServerMessage::ClipPending { clip_id } | ServerMessage::ClipProposed { clip_id, .. } => PendingItem {
                tag: format!("clip:{clip_id}"),
                title: CLIP_TITLE.into(),
                body: CONSENT_BODY.into(),
                nav: format!("clip:{clip_id}"),
            },
            _ => continue,
        };
        if out.iter().any(|o| o.tag == item.tag) {
            continue; // newest already taken for this conversation
        }
        out.push(item);
        if out.len() == MAX_ITEMS {
            break;
        }
    }
    out
}

/// GET /push/web/key — public. `null` means this deployment has no VAPID key
/// and the client should say so instead of offering a switch.
pub async fn public_key(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "key": state.web_push.public_key() }))
}

/// POST /push/web/subscription
pub async fn subscribe(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<SubscribeRequest>,
) -> Response {
    if !state.web_push.enabled() {
        return bad(StatusCode::SERVICE_UNAVAILABLE, "Push notifications are not set up on this server");
    }
    // A token from before the sid claim has no session to bind to, so its
    // pushes could not be stopped by signing it out. Its next renewal mints
    // one; until then, refuse rather than create an unrevocable row.
    if claims.sid.is_empty() {
        return bad(StatusCode::CONFLICT, "Sign out and back in to turn on notifications on this device");
    }
    if let Err(e) = endpoint_allowed(&req.endpoint) {
        return bad(StatusCode::BAD_REQUEST, e);
    }
    if let Err(e) = WebPushTarget::from_b64(&req.endpoint, &req.p256dh, &req.auth) {
        return bad(StatusCode::BAD_REQUEST, e);
    }
    let gates = match req.gates.checked() {
        Ok(g) => g,
        Err(e) => return bad(StatusCode::BAD_REQUEST, e),
    };
    // The session's absolute cap: no renewal can carry it past this, so
    // neither may its pushes.
    let now = chrono::Utc::now().timestamp();
    let start = if claims.sst > 0 { claims.sst } else { now };
    let Some(expires_at) =
        chrono::DateTime::<chrono::Utc>::from_timestamp(start + crate::auth::session_cap_secs(claims.ls), 0)
    else {
        return bad(StatusCode::BAD_REQUEST, "bad session start");
    };
    let mut raw = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut raw);
    let secret = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);

    // ON CONFLICT (endpoint): one browser profile is one subscription. A
    // browser that signed into another account takes its row with it — the
    // old account must not keep being rung on someone else's browser.
    let row: Result<(i64,), sqlx::Error> = sqlx::query_as(
        "INSERT INTO web_push_subscriptions \
             (user_id, sid, token_version, expires_at, endpoint, p256dh, auth, \
              fetch_secret_sha256, muted_servers, muted_channels, blocked_ids) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) \
         ON CONFLICT (endpoint) DO UPDATE SET \
             user_id = EXCLUDED.user_id, sid = EXCLUDED.sid, \
             token_version = EXCLUDED.token_version, expires_at = EXCLUDED.expires_at, \
             p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, \
             fetch_secret_sha256 = EXCLUDED.fetch_secret_sha256, \
             muted_servers = EXCLUDED.muted_servers, muted_channels = EXCLUDED.muted_channels, \
             blocked_ids = EXCLUDED.blocked_ids, created_at = NOW(), last_push_at = NULL \
         RETURNING id",
    )
    .bind(claims.sub as i32)
    .bind(&claims.sid)
    .bind(claims.tv)
    .bind(expires_at)
    .bind(&req.endpoint)
    .bind(&req.p256dh)
    .bind(&req.auth)
    .bind(secret_hash(&secret))
    .bind(&gates.muted_servers)
    .bind(&gates.muted_channels)
    .bind(&gates.blocked_ids)
    .fetch_one(&state.pool)
    .await;
    let id = match row {
        Ok((id,)) => id,
        Err(sqlx::Error::Database(db)) if db.is_foreign_key_violation() => {
            // The session row is missing (a legacy sid, or one written by a
            // mint that failed): nothing could revoke this subscription.
            return bad(StatusCode::CONFLICT, "Sign out and back in to turn on notifications on this device");
        }
        Err(e) => {
            tracing::error!("web push: subscribe failed for user {}: {e}", claims.sub);
            return bad(StatusCode::INTERNAL_SERVER_ERROR, "Could not save the subscription");
        }
    };
    let _ = sqlx::query(
        "DELETE FROM web_push_subscriptions WHERE user_id = $1 AND id NOT IN \
         (SELECT id FROM web_push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2)",
    )
    .bind(claims.sub as i32)
    .bind(MAX_SUBSCRIPTIONS_PER_USER)
    .execute(&state.pool)
    .await;
    state.web_push_watch(claims.sub);
    Json(SubscribeResponse { id, secret }).into_response()
}

/// PATCH /push/web/subscription — this device's mutes or blocks changed, or
/// the app started. Also rebinds the row to the CALLING session: a browser
/// that signed in again (its session expired) holds a new one, and both the
/// "is that browser open" check and revocation follow the session.
pub async fn update_gates(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<UpdateGatesRequest>,
) -> Response {
    let gates = match req.gates.checked() {
        Ok(g) => g,
        Err(e) => return bad(StatusCode::BAD_REQUEST, e),
    };
    if claims.sid.is_empty() {
        return bad(StatusCode::NOT_FOUND, "No such subscription");
    }
    let now = chrono::Utc::now().timestamp();
    let start = if claims.sst > 0 { claims.sst } else { now };
    let Some(expires_at) =
        chrono::DateTime::<chrono::Utc>::from_timestamp(start + crate::auth::session_cap_secs(claims.ls), 0)
    else {
        return bad(StatusCode::BAD_REQUEST, "bad session start");
    };
    match sqlx::query(
        "UPDATE web_push_subscriptions SET muted_servers = $3, muted_channels = $4, blocked_ids = $5, \
             sid = $6, token_version = $7, expires_at = $8 \
         WHERE id = $1 AND user_id = $2",
    )
    .bind(req.id)
    .bind(claims.sub as i32)
    .bind(&gates.muted_servers)
    .bind(&gates.muted_channels)
    .bind(&gates.blocked_ids)
    .bind(&claims.sid)
    .bind(claims.tv)
    .bind(expires_at)
    .execute(&state.pool)
    .await
    {
        Ok(done) if done.rows_affected() == 1 => {
            state.web_push_watch(claims.sub);
            Json(serde_json::json!({ "updated": true })).into_response()
        }
        // Gone (pruned, taken over, signed out): the client subscribes again.
        Ok(_) => bad(StatusCode::NOT_FOUND, "No such subscription"),
        // No session row behind the caller's sid: as for subscribe.
        Err(sqlx::Error::Database(db)) if db.is_foreign_key_violation() => {
            bad(StatusCode::NOT_FOUND, "No such subscription")
        }
        Err(e) => {
            tracing::error!("web push: gate update failed for user {}: {e}", claims.sub);
            bad(StatusCode::INTERNAL_SERVER_ERROR, "Could not update the subscription")
        }
    }
}

/// DELETE /push/web/subscription — turned off, or signing out.
pub async fn unsubscribe(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<UnsubscribeRequest>,
) -> Response {
    match sqlx::query("DELETE FROM web_push_subscriptions WHERE endpoint = $1 AND user_id = $2")
        .bind(&req.endpoint)
        .bind(claims.sub as i32)
        .execute(&state.pool)
        .await
    {
        Ok(done) => {
            let left: Option<(i64,)> =
                sqlx::query_as("SELECT COUNT(*) FROM web_push_subscriptions WHERE user_id = $1")
                    .bind(claims.sub as i32)
                    .fetch_optional(&state.pool)
                    .await
                    .unwrap_or(None);
            if matches!(left, Some((0,))) {
                state.web_push_unwatch(claims.sub);
            }
            Json(serde_json::json!({ "removed": done.rows_affected() > 0 })).into_response()
        }
        Err(e) => {
            tracing::error!("web push: unsubscribe failed for user {}: {e}", claims.sub);
            bad(StatusCode::INTERNAL_SERVER_ERROR, "Could not remove the subscription")
        }
    }
}

/// POST /push/web/test — push to the calling session's browser now, awaited,
/// so the person pressing "Send a test" gets a real answer. Bypasses the rate
/// limit and the notification settings (it is a request, not an event), not
/// the session check.
pub async fn send_test(State(state): State<Arc<AppState>>, Extension(claims): Extension<Claims>) -> Response {
    if !state.web_push.enabled() {
        return bad(StatusCode::SERVICE_UNAVAILABLE, "Push notifications are not set up on this server");
    }
    if claims.sid.is_empty() {
        return bad(StatusCode::NOT_FOUND, "This device has no push subscription");
    }
    let subs = crate::wake::sender::live_subscriptions(&state.pool, claims.sub, Some(&claims.sid)).await;
    if subs.is_empty() {
        return bad(StatusCode::NOT_FOUND, "This device has no push subscription");
    }
    let mut sent = 0usize;
    let mut last_err = None;
    for sub in &subs {
        match crate::wake::sender::push_one(&state, sub).await {
            Ok(()) => sent += 1,
            Err(e) => last_err = Some(e),
        }
    }
    match last_err {
        Some(e) if sent == 0 => {
            tracing::warn!("web push: test failed for user {}: {e}", claims.sub);
            bad(StatusCode::BAD_GATEWAY, format!("The push service refused the test: {e}"))
        }
        _ => Json(serde_json::json!({ "sent": sent })).into_response(),
    }
}

/// The pending route's one query: the row, its secret's hash, its gates, and
/// the same liveness `sender::LIVE_SUBSCRIPTIONS_SQL` computes.
pub const PENDING_SQL: &str = "\
    SELECT w.user_id, w.sid, w.fetch_secret_sha256, \
           w.muted_servers, w.muted_channels, w.blocked_ids, \
           (s.revoked_at IS NULL \
            AND (s.device_id IS NULL OR (d.id IS NOT NULL AND d.revoked_at IS NULL)) \
            AND u.token_version = w.token_version \
            AND w.expires_at > NOW()) AS live \
    FROM web_push_subscriptions w \
    JOIN users u ON u.id = w.user_id \
    JOIN token_sessions s ON s.sid = w.sid \
    LEFT JOIN devices d ON d.id = s.device_id \
    WHERE w.id = $1";

/// POST /push/web/pending — the service worker, woken, asks what knocked.
/// 404 for an unknown id AND for a wrong secret (one answer, so neither can
/// be probed for); 410 for a subscription whose session is gone, which the
/// worker takes as "unsubscribe yourself".
pub async fn pending(State(state): State<Arc<AppState>>, Json(req): Json<PendingRequest>) -> Response {
    type Row = (i32, String, String, Vec<String>, Vec<i64>, Vec<i64>, bool);
    let row: Option<Row> = match sqlx::query_as(PENDING_SQL).bind(req.id).fetch_optional(&state.pool).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("web push: pending lookup failed: {e}");
            return bad(StatusCode::SERVICE_UNAVAILABLE, "try again");
        }
    };
    let Some((user_id, sid, stored_hash, muted_servers, muted_channels, blocked_ids, live)) = row else {
        return bad(StatusCode::NOT_FOUND, "No such subscription");
    };
    // Both sides are fixed-length hex of a SHA-256, so comparing them leaks
    // nothing about the secret itself.
    if req.secret.len() > 128 || secret_hash(&req.secret) != stored_hash {
        return bad(StatusCode::NOT_FOUND, "No such subscription");
    }
    if !live {
        let _ = sqlx::query("DELETE FROM web_push_subscriptions WHERE id = $1")
            .bind(req.id)
            .execute(&state.pool)
            .await;
        return bad(StatusCode::GONE, "This subscription's session has ended");
    }
    let gates = WebGates { muted_servers, muted_channels, blocked_ids };
    let user_id = user_id as UserId;
    let items = pending_items(&state.web_push_unseen(user_id, req.id, &sid), user_id, &gates);
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({ "items": items })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::UserInfo;

    fn chan(server: &str, channel: i64, author: i64, name: &str) -> ServerMessage {
        ServerMessage::MessageNotification {
            server_id: server.into(),
            channel_id: channel,
            message_id: "m".into(),
            author: UserInfo::new(author, name.into()),
        }
    }

    fn dm(conv: &str, sender: i64, name: &str, content: &str) -> ServerMessage {
        ServerMessage::DirectMessage {
            message_id: "m".into(),
            conversation_id: conv.into(),
            sender: UserInfo::new(sender, name.into()),
            content: content.into(),
            timestamp: 0,
        }
    }

    #[test]
    fn what_knocked_is_named_by_sender_and_never_by_content() {
        let frames = vec![
            chan("srv-1", 5, 2, "bob"),
            dm("conv-9", 3, "alice", "SECRET-CIPHERTEXT-BYTES"),
        ];
        let items = pending_items(&frames, 1, &WebGates::default());
        assert_eq!(
            items,
            vec![
                PendingItem {
                    tag: "dm:conv-9".into(),
                    title: "alice sent you a message".into(),
                    body: "New message".into(),
                    nav: "dm:conv-9".into(),
                },
                PendingItem {
                    tag: "chan:srv-1".into(),
                    title: "bob sent a message".into(),
                    body: "New message".into(),
                    nav: "server:srv-1".into(),
                },
            ],
            "newest first, Android's titles and keys"
        );
        let json = serde_json::to_string(&items).unwrap();
        assert!(!json.contains("SECRET"), "a DM's content must never reach the worker: {json}");
    }

    #[test]
    fn own_blocked_and_muted_frames_never_notify() {
        let gates = WebGates {
            muted_servers: vec!["srv-muted".into()],
            muted_channels: vec![77],
            blocked_ids: vec![13],
        };
        let frames = vec![
            chan("srv-1", 5, 1, "me"),        // my own
            dm("c1", 1, "me", "x"),           // my own echo
            chan("srv-muted", 5, 2, "bob"),   // muted server
            chan("srv-1", 77, 2, "bob"),      // muted channel
            chan("srv-1", 5, 13, "troll"),    // blocked
            dm("c2", 13, "troll", "x"),       // blocked
        ];
        assert!(pending_items(&frames, 1, &gates).is_empty());
        // Control: the same frames for another user with no gates all notify
        // (minus that user's own — none here).
        assert_eq!(pending_items(&frames, 99, &WebGates::default()).len(), 4, "capped, de-duplicated per conversation");
    }

    #[test]
    fn a_clip_prompt_survives_every_gate_and_names_nobody() {
        let gates = WebGates { muted_servers: vec!["s".into()], muted_channels: vec![1], blocked_ids: vec![2] };
        let items = pending_items(&[ServerMessage::ClipPending { clip_id: "clip-7".into() }], 1, &gates);
        assert_eq!(
            items,
            vec![PendingItem {
                tag: "clip:clip-7".into(),
                title: "Approval needed".into(),
                body: "Open Púca to approve or decline".into(),
                nav: "clip:clip-7".into(),
            }]
        );
    }

    #[test]
    fn one_notification_per_conversation_newest_wins_and_at_most_four() {
        let frames: Vec<ServerMessage> = vec![
            dm("c1", 2, "old-name", "x"),
            dm("c1", 2, "new-name", "x"),
            chan("s1", 1, 3, "a"),
            chan("s2", 1, 3, "a"),
            chan("s3", 1, 3, "a"),
            chan("s4", 1, 3, "a"),
        ];
        let items = pending_items(&frames, 1, &WebGates::default());
        assert_eq!(items.len(), 4);
        assert_eq!(items[0].tag, "chan:s4");
        let frames = vec![dm("c1", 2, "old-name", "x"), dm("c1", 2, "new-name", "x")];
        let items = pending_items(&frames, 1, &WebGates::default());
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "new-name sent you a message");
    }

    #[test]
    fn a_hostile_display_name_stays_one_bounded_line() {
        let long = "x".repeat(500);
        let items = pending_items(&[dm("c", 2, &format!("eve\n\u{7}{long}"), "x")], 1, &WebGates::default());
        assert!(!items[0].title.contains('\n'));
        assert!(items[0].title.chars().count() <= 64 + " sent you a message".len());
        let items = pending_items(&[dm("c", 2, "\n\t", "x")], 1, &WebGates::default());
        assert_eq!(items[0].title, "Someone sent you a message");
    }

    /// The fourth copy of the doorbell's words. The Android parser and this
    /// module must title the same frame the same way, or one person's two
    /// devices disagree about who messaged them.
    #[test]
    fn the_web_push_titles_are_the_android_apps_word_for_word() {
        let java = include_str!("../frontend/android/app/src/main/java/com/sovereign/app/PushFrames.java");
        for lit in [GENERIC_BODY, CLIP_TITLE, CONSENT_BODY] {
            assert!(java.contains(&format!("\"{lit}\"")), "PushFrames.java must carry \"{lit}\"");
        }
        assert!(java.contains("username + \" sent a message\""));
        assert!(java.contains("username + \" sent you a message\""));
        let sw = include_str!("../frontend/public/sw.js");
        for lit in [GENERIC_TITLE, GENERIC_ACTIVITY] {
            assert!(sw.contains(&format!("'{lit}'")), "sw.js must carry the generic fallback '{lit}'");
        }
    }

    #[test]
    fn gate_lists_are_bounded() {
        let too_many = GatesBody { muted_channels: vec![1; MAX_GATE_ENTRIES + 1], ..GatesBody::default() };
        assert!(too_many.checked().is_err());
        let long_id = GatesBody { muted_servers: vec!["x".repeat(65)], ..GatesBody::default() };
        assert!(long_id.checked().is_err());
        assert!(GatesBody::default().checked().is_ok());
    }
}
