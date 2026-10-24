//! Web Push against a real database (TEST_DATABASE_URL only; they skip without
//! it, like every DB test here — see CLAUDE.md). The transport is a recorder,
//! so these test the DECISIONS — who is rung, who is pruned, what the worker is
//! told — over the real SQL; the wire is tested in wake/webpush.rs.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::to_bytes;
use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::Json;

use crate::auth::Claims;
use crate::protocol::{ServerMessage, UserInfo};
use crate::push_web_handlers::{self as h, GatesBody, PendingRequest, SubscribeRequest, UnsubscribeRequest, UpdateGatesRequest};
use crate::state::AppState;
use crate::wake::sender::{self, WakeKind, WakeScope};
use crate::wake::webpush::{WebPushTarget, WebPushTransport};
use crate::wake::WakeError;

/// Records every push and answers from a script (Ok when it runs out).
#[derive(Default)]
struct Recorder {
    pushed: Mutex<Vec<String>>,
    script: Mutex<VecDeque<Result<(), WakeError>>>,
}

struct RecorderHandle(Arc<Recorder>);

#[async_trait::async_trait]
impl WebPushTransport for RecorderHandle {
    async fn push(&self, target: &WebPushTarget) -> Result<(), WakeError> {
        self.0.pushed.lock().unwrap().push(target.endpoint.clone());
        self.0.script.lock().unwrap().pop_front().unwrap_or(Ok(()))
    }
    fn public_key(&self) -> Option<String> {
        Some("BPUBLIC".into())
    }
}

impl Recorder {
    fn count(&self) -> usize {
        self.pushed.lock().unwrap().len()
    }
}

async fn setup() -> Option<(sqlx::PgPool, Arc<AppState>, Arc<Recorder>)> {
    let pool = crate::migrator::test_pool(4).await?;
    let rec = Arc::new(Recorder::default());
    let state = AppState::new_with_web_push(
        pool.clone(),
        "test-secret".into(),
        None,
        Arc::new(crate::wake::NullWake),
        Arc::new(RecorderHandle(rec.clone())),
    );
    Some((pool, state, rec))
}

/// A user with a live session; returns the claims a request from it carries.
async fn signed_in(pool: &sqlx::PgPool, tag: &str) -> Claims {
    let username = format!("wp_{tag}_{}", uuid::Uuid::new_v4());
    let (id,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, '00', '00') RETURNING id")
        .bind(&username)
        .fetch_one(pool)
        .await
        .expect("insert user");
    let (tv,): (i32,) = sqlx::query_as("SELECT token_version FROM users WHERE id = $1").bind(id).fetch_one(pool).await.unwrap();
    let sid = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO token_sessions (sid, user_id) VALUES ($1, $2)")
        .bind(&sid)
        .bind(id)
        .execute(pool)
        .await
        .expect("insert session");
    Claims {
        sub: id as i64,
        username,
        exp: chrono::Utc::now().timestamp() + 3600,
        tv,
        sst: chrono::Utc::now().timestamp(),
        sid,
        ls: true,
    }
}

async fn drop_user(pool: &sqlx::PgPool, c: &Claims) {
    let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(c.sub as i32).execute(pool).await;
}

fn browser_keys() -> (String, String) {
    let (_, t) = crate::wake::webpush::tests::browser("https://fcm.googleapis.com/x");
    use base64::Engine;
    let b = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    (b.encode(&t.p256dh), b.encode(&t.auth))
}

fn endpoint() -> String {
    format!("https://fcm.googleapis.com/fcm/send/{}", uuid::Uuid::new_v4())
}

async fn body_json(r: Response) -> (StatusCode, serde_json::Value) {
    let status = r.status();
    let bytes = to_bytes(r.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
}

async fn subscribe(state: &Arc<AppState>, c: &Claims, ep: &str, gates: GatesBody) -> (i64, String) {
    let (p256dh, auth) = browser_keys();
    let r = h::subscribe(
        State(state.clone()),
        Extension(c.clone()),
        Json(SubscribeRequest { endpoint: ep.into(), p256dh, auth, gates }),
    )
    .await;
    let (status, v) = body_json(r).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    (v["id"].as_i64().unwrap(), v["secret"].as_str().unwrap().to_string())
}

async fn pending(state: &Arc<AppState>, id: i64, secret: &str) -> (StatusCode, serde_json::Value) {
    body_json(h::pending(State(state.clone()), Json(PendingRequest { id, secret: secret.into() })).await).await
}

async fn rows_for(pool: &sqlx::PgPool, c: &Claims) -> i64 {
    sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM web_push_subscriptions WHERE user_id = $1")
        .bind(c.sub as i32)
        .fetch_one(pool)
        .await
        .unwrap()
        .0
}

fn dm_from(sender: &Claims, conv: &str) -> ServerMessage {
    ServerMessage::DirectMessage {
        message_id: "m".into(),
        conversation_id: conv.into(),
        sender: UserInfo::new(sender.sub, sender.username.clone()),
        content: "CIPHERTEXT".into(),
        timestamp: 0,
    }
}

/// The whole round: subscribe, a DM parks, the push goes out, the worker asks
/// what knocked and is told who — not what — and a wrong secret learns nothing.
#[tokio::test]
async fn a_parked_dm_rings_the_browser_and_the_worker_learns_only_who() {
    let Some((pool, state, rec)) = setup().await else { return };
    let me = signed_in(&pool, "me").await;
    let alice = signed_in(&pool, "alice").await;
    let ep = endpoint();
    let (id, secret) = subscribe(&state, &me, &ep, GatesBody::default()).await;

    // What `wake_user_scoped` logs before it rings.
    state.web_push_record(me.sub, dm_from(&alice, "conv-1"));
    let rung = sender::ring_web_now(&state, me.sub, WakeKind::DirectMessage, &WakeScope::dm(alice.sub)).await;
    assert_eq!(rung, 1);
    assert_eq!(rec.pushed.lock().unwrap().as_slice(), &[ep.clone()]);

    let (status, v) = pending(&state, id, &secret).await;
    assert_eq!(status, StatusCode::OK);
    let items = v["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["title"], format!("{} sent you a message", alice.username));
    assert_eq!(items[0]["body"], "New message");
    assert_eq!(items[0]["nav"], "dm:conv-1");
    assert!(!v.to_string().contains("CIPHERTEXT"));
    // Told once: the next wake's worker is not told about it again.
    let (_, again) = pending(&state, id, &secret).await;
    assert_eq!(again["items"].as_array().unwrap().len(), 0);

    // Wrong secret and unknown id: one answer, nothing learned.
    let (s1, _) = pending(&state, id, "wrong").await;
    let (s2, _) = pending(&state, id + 1_000_000, &secret).await;
    assert_eq!((s1, s2), (StatusCode::NOT_FOUND, StatusCode::NOT_FOUND));

    drop_user(&pool, &me).await;
    drop_user(&pool, &alice).await;
}

/// Signing the session out, revoking it, or bumping token_version each stop
/// the pushes — and the dead row is deleted when next looked at.
#[tokio::test]
async fn every_way_of_signing_a_device_out_stops_its_pushes() {
    let Some((pool, state, rec)) = setup().await else { return };

    // 1. Session revoked (sign out this session from another device).
    let me = signed_in(&pool, "rev").await;
    let (id, secret) = subscribe(&state, &me, &endpoint(), GatesBody::default()).await;
    sqlx::query("UPDATE token_sessions SET revoked_at = NOW() WHERE sid = $1").bind(&me.sid).execute(&pool).await.unwrap();
    assert_eq!(sender::ring_web_now(&state, me.sub, WakeKind::DirectMessage, &WakeScope::dm(1)).await, 0);
    assert_eq!(rec.count(), 0, "no push for a revoked session");
    assert_eq!(rows_for(&pool, &me).await, 0, "and its row is gone");
    let (status, _) = pending(&state, id, &secret).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    drop_user(&pool, &me).await;

    // 2. token_version bumped (sign out everywhere, password change).
    let me = signed_in(&pool, "tv").await;
    let (id, secret) = subscribe(&state, &me, &endpoint(), GatesBody::default()).await;
    sqlx::query("UPDATE users SET token_version = token_version + 1 WHERE id = $1").bind(me.sub as i32).execute(&pool).await.unwrap();
    // The worker asks first this time: 410, and the row goes.
    let (status, _) = pending(&state, id, &secret).await;
    assert_eq!(status, StatusCode::GONE);
    assert_eq!(rows_for(&pool, &me).await, 0);
    drop_user(&pool, &me).await;

    // 3. This session signs itself out.
    let me = signed_in(&pool, "out").await;
    subscribe(&state, &me, &endpoint(), GatesBody::default()).await;
    let r = crate::handlers::logout_session(State(state.clone()), Extension(me.clone())).await;
    assert_eq!(axum::response::IntoResponse::into_response(r).status(), StatusCode::OK);
    assert_eq!(rows_for(&pool, &me).await, 0, "sign-out deletes this session's subscription");
    drop_user(&pool, &me).await;

    // 4. The session's absolute cap has passed.
    let mut me = signed_in(&pool, "cap").await;
    me.ls = false;
    me.sst = chrono::Utc::now().timestamp() - crate::auth::session_cap_secs(false) - 60;
    subscribe(&state, &me, &endpoint(), GatesBody::default()).await;
    assert_eq!(sender::ring_web_now(&state, me.sub, WakeKind::DirectMessage, &WakeScope::dm(1)).await, 0);
    assert_eq!(rec.count(), 0);
    drop_user(&pool, &me).await;

    // Control: a live session on the same state IS rung — the zeros above
    // are the revocations, not a transport that never sends.
    let me = signed_in(&pool, "live").await;
    subscribe(&state, &me, &endpoint(), GatesBody::default()).await;
    assert_eq!(sender::ring_web_now(&state, me.sub, WakeKind::DirectMessage, &WakeScope::dm(1)).await, 1);
    drop_user(&pool, &me).await;
}

/// The device's mutes and blocks, and the user's notification settings, are
/// applied before anything is sent.
#[tokio::test]
async fn mutes_blocks_and_settings_are_honoured_before_sending() {
    let Some((pool, state, rec)) = setup().await else { return };
    let me = signed_in(&pool, "gates").await;
    let (id, _) = subscribe(
        &state,
        &me,
        &endpoint(),
        GatesBody { muted_servers: vec!["srv-muted".into()], muted_channels: vec![77], blocked_ids: vec![13] },
    )
    .await;
    assert_eq!(sender::ring_web_now(&state, me.sub, WakeKind::ChannelMessage, &WakeScope::channel("srv-muted", 1, 2)).await, 0);
    assert_eq!(sender::ring_web_now(&state, me.sub, WakeKind::ChannelMessage, &WakeScope::channel("srv-1", 77, 2)).await, 0);
    assert_eq!(sender::ring_web_now(&state, me.sub, WakeKind::DirectMessage, &WakeScope::dm(13)).await, 0);
    assert_eq!(rec.count(), 0, "nothing reached the push service");
    // Control.
    assert_eq!(sender::ring_web_now(&state, me.sub, WakeKind::ChannelMessage, &WakeScope::channel("srv-1", 1, 2)).await, 1);

    // The device changed its mutes: the new set applies.
    let r = h::update_gates(
        State(state.clone()),
        Extension(me.clone()),
        Json(UpdateGatesRequest { id, gates: GatesBody { muted_channels: vec![1], ..GatesBody::default() } }),
    )
    .await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(sender::ring_web_now(&state, me.sub, WakeKind::ChannelMessage, &WakeScope::channel("srv-1", 1, 2)).await, 0);
    assert_eq!(sender::ring_web_now(&state, me.sub, WakeKind::ChannelMessage, &WakeScope::channel("srv-muted", 5, 2)).await, 1);
    // Someone else cannot change them.
    let other = signed_in(&pool, "other").await;
    let r = h::update_gates(State(state.clone()), Extension(other.clone()), Json(UpdateGatesRequest { id, gates: GatesBody::default() })).await;
    assert_eq!(r.status(), StatusCode::NOT_FOUND);

    // The user's own notification settings (notification_preferences).
    sqlx::query("INSERT INTO notification_preferences (user_id, push_dms) VALUES ($1, false)")
        .bind(me.sub as i32)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(sender::ring_web_now(&state, me.sub, WakeKind::DirectMessage, &WakeScope::dm(2)).await, 0, "DMs off");
    assert_eq!(sender::ring_web_now(&state, me.sub, WakeKind::ChannelMessage, &WakeScope::channel("s", 5, 2)).await, 1, "channel messages still on");

    drop_user(&pool, &me).await;
    drop_user(&pool, &other).await;
}

/// A browser that signs into another account takes its subscription with it,
/// and only the owner can remove theirs.
#[tokio::test]
async fn one_browser_one_account_and_only_the_owner_unsubscribes() {
    let Some((pool, state, rec)) = setup().await else { return };
    let a = signed_in(&pool, "a").await;
    let b = signed_in(&pool, "b").await;
    let ep = endpoint();
    subscribe(&state, &a, &ep, GatesBody::default()).await;
    subscribe(&state, &b, &ep, GatesBody::default()).await;
    assert_eq!(rows_for(&pool, &a).await, 0, "A is no longer rung on B's browser");
    assert_eq!(rows_for(&pool, &b).await, 1);
    assert_eq!(sender::ring_web_now(&state, a.sub, WakeKind::DirectMessage, &WakeScope::dm(9)).await, 0);
    assert_eq!(rec.count(), 0);

    let r = h::unsubscribe(State(state.clone()), Extension(a.clone()), Json(UnsubscribeRequest { endpoint: ep.clone() })).await;
    assert_eq!(body_json(r).await.1["removed"], false, "A cannot remove B's subscription");
    let r = h::unsubscribe(State(state.clone()), Extension(b.clone()), Json(UnsubscribeRequest { endpoint: ep.clone() })).await;
    assert_eq!(body_json(r).await.1["removed"], true);
    assert_eq!(rows_for(&pool, &b).await, 0);
    drop_user(&pool, &a).await;
    drop_user(&pool, &b).await;
}

/// Only a 404/410 from the push service prunes; a 503 keeps the row.
#[tokio::test]
async fn a_gone_subscription_is_pruned_and_an_outage_is_not() {
    let Some((pool, state, rec)) = setup().await else { return };
    let me = signed_in(&pool, "prune").await;
    subscribe(&state, &me, &endpoint(), GatesBody::default()).await;
    rec.script.lock().unwrap().push_back(Err(WakeError::Transient("HTTP 503".into())));
    assert_eq!(sender::ring_web_now(&state, me.sub, WakeKind::DirectMessage, &WakeScope::dm(2)).await, 0);
    assert_eq!(rows_for(&pool, &me).await, 1, "an outage keeps the subscription");
    rec.script.lock().unwrap().push_back(Err(WakeError::Unregistered));
    assert_eq!(sender::ring_web_now(&state, me.sub, WakeKind::DirectMessage, &WakeScope::dm(2)).await, 0);
    assert_eq!(rows_for(&pool, &me).await, 0, "a 410 prunes it");
    drop_user(&pool, &me).await;
}

/// The burst coalesces to one push per 30 s — but a ring that sent nothing
/// (a muted channel) does not use up the slot for the DM after it.
#[tokio::test]
async fn a_burst_is_one_push_and_a_muted_ring_does_not_spend_the_slot() {
    let Some((pool, state, rec)) = setup().await else { return };
    let me = signed_in(&pool, "burst").await;
    subscribe(&state, &me, &endpoint(), GatesBody { muted_channels: vec![77], ..GatesBody::default() }).await;

    let frame = dm_from(&me, "c");
    async fn settle(rec: &Recorder, want: usize) -> usize {
        for _ in 0..50 {
            if rec.count() >= want {
                break;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
        rec.count()
    }

    // A muted channel's message: nothing sent, slot handed back.
    sender::wake_user_scoped(&state, me.sub, WakeKind::ChannelMessage, WakeScope::channel("s", 77, 2), &frame, false);
    assert_eq!(settle(&rec, 1).await, 0);
    // The DM right after it still rings...
    sender::wake_user_scoped(&state, me.sub, WakeKind::DirectMessage, WakeScope::dm(2), &frame, false);
    assert_eq!(settle(&rec, 1).await, 1);
    // ...and the burst behind it does not.
    for _ in 0..5 {
        sender::wake_user_scoped(&state, me.sub, WakeKind::DirectMessage, WakeScope::dm(2), &frame, false);
    }
    assert_eq!(settle(&rec, 2).await, 1, "one push per burst");
    drop_user(&pool, &me).await;
}

/// A live connection of the session `sid`, as the WebSocket would register it.
fn connect(state: &Arc<AppState>, c: &Claims, sid: &str) -> u64 {
    let (tx, _rx) = tokio::sync::mpsc::channel(8);
    std::mem::forget(_rx); // keep the channel open: a closed one is a dead socket
    state.register_session(c.sub, c.username.clone(), tx, false, None, sid.to_string()).0
}

/// THE PER-BROWSER RULE. The desktop app being open must not silence the
/// phone (the Android phone in the same position is notified), but the
/// browser that subscribed being open must not be pushed to: it has the frame
/// and notifies itself. And what it saw while open is not named later.
#[tokio::test]
async fn a_browser_is_rung_when_it_is_away_whatever_the_other_devices_do() {
    let Some((pool, state, rec)) = setup().await else { return };
    let me = signed_in(&pool, "perbrowser").await;
    let alice = signed_in(&pool, "alice2").await;
    let (id, secret) = subscribe(&state, &me, &endpoint(), GatesBody::default()).await;

    // 1. The desktop app (another session) is connected; the phone is not.
    let desktop_sid = uuid::Uuid::new_v4().to_string();
    let _desktop = connect(&state, &me, &desktop_sid);
    let frame = dm_from(&alice, "conv-a");
    assert!(state.send_to_user(me.sub, frame.clone()), "the desktop takes the frame");
    sender::wake_user_scoped(&state, me.sub, WakeKind::DirectMessage, WakeScope::dm(alice.sub), &frame, true);
    for _ in 0..50 {
        if rec.count() > 0 { break; }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    assert_eq!(rec.count(), 1, "the phone is rung although the desktop app is open");
    let (_, v) = pending(&state, id, &secret).await;
    assert_eq!(v["items"][0]["nav"], "dm:conv-a");

    // 2. The phone's own browser opens: no push, and its worker is told nothing.
    let phone_conn = connect(&state, &me, &me.sid);
    state.web_push_record(me.sub, dm_from(&alice, "conv-b"));
    assert_eq!(sender::ring_web_now(&state, me.sub, WakeKind::DirectMessage, &WakeScope::dm(alice.sub)).await, 0);
    assert_eq!(rec.count(), 1, "no push to a browser that is open");
    let (_, v) = pending(&state, id, &secret).await;
    assert_eq!(v["items"].as_array().unwrap().len(), 0, "the open app has it");

    // 3. The phone goes away again: conv-b, seen while it was open, is not
    // named; what arrives after is.
    state.web_push_record(me.sub, dm_from(&alice, "conv-c"));
    state.unregister_session(me.sub, phone_conn);
    state.web_push_record(me.sub, dm_from(&alice, "conv-d"));
    assert_eq!(sender::ring_web_now(&state, me.sub, WakeKind::DirectMessage, &WakeScope::dm(alice.sub)).await, 1);
    let (_, v) = pending(&state, id, &secret).await;
    let navs: Vec<&str> = v["items"].as_array().unwrap().iter().map(|i| i["nav"].as_str().unwrap()).collect();
    assert_eq!(navs, vec!["dm:conv-d"], "only what arrived while it was away");

    drop_user(&pool, &me).await;
    drop_user(&pool, &alice).await;
}

/// Signing in again mints a new session; the app's start-up PATCH moves the
/// subscription to it, so "is that browser open" and revocation follow.
#[tokio::test]
async fn the_start_up_patch_rebinds_the_subscription_to_the_new_session() {
    let Some((pool, state, rec)) = setup().await else { return };
    let me = signed_in(&pool, "rebind").await;
    let (id, _) = subscribe(&state, &me, &endpoint(), GatesBody::default()).await;
    let new_sid = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO token_sessions (sid, user_id) VALUES ($1, $2)").bind(&new_sid).bind(me.sub as i32).execute(&pool).await.unwrap();
    let again = Claims { sid: new_sid.clone(), ..me.clone() };
    let r = h::update_gates(State(state.clone()), Extension(again.clone()), Json(UpdateGatesRequest { id, gates: GatesBody::default() })).await;
    assert_eq!(r.status(), StatusCode::OK);
    let (sid,): (String,) = sqlx::query_as("SELECT sid FROM web_push_subscriptions WHERE id = $1").bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(sid, new_sid);
    // The OLD session signing out no longer stops it; the new one's does.
    sqlx::query("UPDATE token_sessions SET revoked_at = NOW() WHERE sid = $1").bind(&me.sid).execute(&pool).await.unwrap();
    assert_eq!(sender::ring_web_now(&state, me.sub, WakeKind::DirectMessage, &WakeScope::dm(2)).await, 1);
    sqlx::query("UPDATE token_sessions SET revoked_at = NOW() WHERE sid = $1").bind(&new_sid).execute(&pool).await.unwrap();
    assert_eq!(sender::ring_web_now(&state, me.sub, WakeKind::DirectMessage, &WakeScope::dm(2)).await, 0);
    assert_eq!(rec.count(), 1);
    drop_user(&pool, &me).await;
}

/// The test button pushes to THIS session's browser only.
#[tokio::test]
async fn the_test_button_rings_only_the_calling_sessions_browser() {
    let Some((pool, state, rec)) = setup().await else { return };
    let me = signed_in(&pool, "test").await;
    let ep_here = endpoint();
    subscribe(&state, &me, &ep_here, GatesBody::default()).await;
    // A second session (another browser) of the same account.
    let sid2 = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO token_sessions (sid, user_id) VALUES ($1, $2)").bind(&sid2).bind(me.sub as i32).execute(&pool).await.unwrap();
    let other_session = Claims { sid: sid2, ..me.clone() };
    subscribe(&state, &other_session, &endpoint(), GatesBody::default()).await;

    let (status, v) = body_json(h::send_test(State(state.clone()), Extension(me.clone())).await).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["sent"], 1);
    assert_eq!(rec.pushed.lock().unwrap().as_slice(), &[ep_here]);
    drop_user(&pool, &me).await;
}

/// A token from before the sid claim cannot subscribe: nothing could ever
/// revoke the row it would make.
#[tokio::test]
async fn a_session_that_cannot_be_revoked_cannot_subscribe() {
    let Some((pool, state, _rec)) = setup().await else { return };
    let me = signed_in(&pool, "legacy").await;
    let (p256dh, auth) = browser_keys();
    let legacy = Claims { sid: String::new(), ..me.clone() };
    let r = h::subscribe(
        State(state.clone()),
        Extension(legacy),
        Json(SubscribeRequest { endpoint: endpoint(), p256dh: p256dh.clone(), auth: auth.clone(), gates: GatesBody::default() }),
    )
    .await;
    assert_eq!(r.status(), StatusCode::CONFLICT);
    // A sid with no session row behind it: the same.
    let ghost = Claims { sid: "no-such-session".into(), ..me.clone() };
    let r = h::subscribe(
        State(state.clone()),
        Extension(ghost),
        Json(SubscribeRequest { endpoint: endpoint(), p256dh: p256dh.clone(), auth: auth.clone(), gates: GatesBody::default() }),
    )
    .await;
    assert_eq!(r.status(), StatusCode::CONFLICT);
    // And an endpoint off the push-service list is refused.
    let r = h::subscribe(
        State(state.clone()),
        Extension(me.clone()),
        Json(SubscribeRequest { endpoint: "https://10.20.30.40/push".into(), p256dh, auth, gates: GatesBody::default() }),
    )
    .await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    assert_eq!(rows_for(&pool, &me).await, 0);
    drop_user(&pool, &me).await;
}
